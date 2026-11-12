"""Optional Pi integration smoke test. Uses synthetic data and a localhost-only mock API."""
import json
import os
from pathlib import Path
from queue import Queue, Empty
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
GOOD = {"repeatability": "high", "contract": "high", "judgment": "low", "side_effects": "no"}

class Handler(BaseHTTPRequestHandler):
    requests = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        type(self).requests += 1
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        if self.path.endswith("systemone"):
            assert "synthetic skill" in body["state"]["skill"]
            answers = {k: {"type": "choice", "choice": v, "confidence": 0.9,
                           "probabilities": {v: 1.0}} for k, v in GOOD.items()}
            data = json.dumps({"model": "jev-latest", "answers": answers,
                               "usage": {"input_tokens": 30, "output_tokens": 10}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path.endswith("chat/completions"):
            request = json.dumps(body)
            if 'bounded review' in request:
                assert 'synthetic skill' in request
                text = json.dumps({
                    'decision': 'candidate', 'reason': 'A distinct verified synthetic procedure.',
                    'name': 'fixture-check', 'description': 'Check a synthetic fixture when testing.',
                    'body': '## Steps\nRun the synthetic fixture.\n\n## Validation\nCheck the result.',
                    'evidence': [
                        {'kind': 'procedure', 'quote': 'Run the synthetic fixture and inspect the output.'},
                        {'kind': 'verification', 'quote': 'The synthetic fixture passed verification.'},
                    ],
                })
            elif 'synthetic skill' in request:
                text = json.dumps({"dimensions": GOOD, "evidence": ["synthetic skill"], "boundary": "Automate local processing."})
            else:
                text = 'The synthetic fixture passed verification.'
            chunks = [
                {"id": "mock", "object": "chat.completion.chunk", "created": 1, "model": "mock", "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
                {"id": "mock", "object": "chat.completion.chunk", "created": 1, "model": "mock", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            data = ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks).encode() + b'data: [DONE]\n\n'
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        agent = tmp / 'agent'
        agent.mkdir()
        skills = tmp / 'skills'
        skills.mkdir()
        for i in range(1, 22):
            name = f'demo-{i:02d}'
            skill = skills / name
            skill.mkdir()
            (skill / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Synthetic demo\n---\nsynthetic skill {i}\n')
        base = f'http://127.0.0.1:{server.server_port}'
        (agent / 'models.json').write_text(json.dumps({"providers": {
            "audit-mock": {"baseUrl": base + '/v1', "api": "openai-completions", "apiKey": "fake",
                           "models": [{"id": "mock", "name": "Mock"}]},
            "typesafe": {"baseUrl": base + '/v1'},
        }}))
        env = {**os.environ, 'PI_CODING_AGENT_DIR': str(agent), 'TYPESAFE_API_KEY': 'fake'}
        proc = subprocess.Popen(['pi', '--offline', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp',
                                 '--no-skills', '--skill', str(skills), '--provider', 'audit-mock', '--model', 'mock',
                                 '-e', str(ROOT / 'extensions/skill-audit/index.ts')],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=tmp)
        lines = Queue()
        threading.Thread(target=lambda: [lines.put(line) for line in proc.stdout], daemon=True).start()
        def send(value):
            proc.stdin.write(json.dumps(value) + '\n')
            proc.stdin.flush()
        def get():
            try:
                return json.loads(lines.get(timeout=20))
            except Empty:
                raise AssertionError('Timed out waiting for Pi RPC')
        def choose_batch(event):
            if event['title'].startswith('Choose skills to audit'):
                assert '21 loaded' in event['title'], event
                return next(option for option in event['options'] if option.startswith('All loaded skills'))
            assert event['title'].startswith('Choose one batch'), event
            assert event['options'] == ['Batch 1/2: 1–20 of 21 skills', 'Batch 2/2: 21–21 of 21 skills'], event
            return event['options'][-1]
        try:
            send({'id': 'commands', 'type': 'get_commands'})
            while True:
                event = get()
                if event.get('id') == 'commands':
                    assert any(c['name'] == 'skill-audit' for c in event['data']['commands'])
                    break
            send({'id': 'cancel-batch', 'type': 'prompt', 'message': '/skill-audit run --mode compare'})
            cancelled_batch = False
            while True:
                event = get()
                if event.get('type') == 'extension_ui_request':
                    method = event['method']
                    if method == 'select':
                        selected = choose_batch(event)
                        if event['title'].startswith('Choose one batch'):
                            cancelled_batch = True
                            send({'type': 'extension_ui_response', 'id': event['id'], 'cancelled': True})
                        else:
                            send({'type': 'extension_ui_response', 'id': event['id'], 'value': selected})
                    elif method in ('editor', 'confirm'):
                        raise AssertionError('Cancelled batch continued to preview or consent')
                    elif method == 'notify' and event.get('notifyType') == 'error':
                        raise AssertionError(event['message'])
                if event.get('id') == 'cancel-batch' and event.get('type') == 'response':
                    assert event.get('success'), event
                    break
            assert cancelled_batch, 'No batch picker displayed'
            assert Handler.requests == 0, 'Cancelled batch contacted a provider'
            send({'id': 'cancel-preview', 'type': 'prompt', 'message': '/skill-audit run --mode compare'})
            cancelled_preview = False
            while True:
                event = get()
                if event.get('type') == 'extension_ui_request':
                    method = event['method']
                    if method == 'select':
                        send({'type': 'extension_ui_response', 'id': event['id'], 'value': choose_batch(event)})
                    elif method == 'editor':
                        assert event['title'].startswith('Review files and providers'), event
                        cancelled_preview = True
                        send({'type': 'extension_ui_response', 'id': event['id'], 'cancelled': True})
                    elif method == 'confirm':
                        raise AssertionError('Cancelled preview still opened a confirmation dialog')
                    elif method == 'notify' and event.get('notifyType') == 'error':
                        raise AssertionError(event['message'])
                if event.get('id') == 'cancel-preview' and event.get('type') == 'response':
                    assert event.get('success'), event
                    break
            assert cancelled_preview, 'No file preview displayed'
            assert Handler.requests == 0, 'Cancelled preview contacted a provider'
            send({'id': 'run', 'type': 'prompt', 'message': '/skill-audit run --mode compare'})
            seen_report = False
            while True:
                event = get()
                if event.get('type') == 'extension_ui_request':
                    method = event['method']
                    if method == 'select':
                        send({'type': 'extension_ui_response', 'id': event['id'], 'value': choose_batch(event)})
                    elif method == 'confirm':
                        send({'type': 'extension_ui_response', 'id': event['id'], 'confirmed': event['title'] == 'Send selected skill contents?'})
                    elif method == 'editor':
                        if event['title'].startswith('Skill audit report'):
                            report = event['prefill']
                            assert 'LLM: tool candidate' in report, report
                            assert 'JEV: tool candidate' in report, report
                            assert 'demo-21' in report and 'demo-01' not in report, report
                            seen_report = True
                            send({'type': 'extension_ui_response', 'id': event['id'], 'cancelled': True})
                        else:
                            send({'type': 'extension_ui_response', 'id': event['id'], 'value': event['prefill']})
                    elif method == 'notify' and event.get('notifyType') == 'error':
                        raise AssertionError(event['message'])
                if event.get('id') == 'run' and event.get('type') == 'response':
                    assert event.get('success'), event
                    break
            assert seen_report, 'No report displayed'
            assert Handler.requests == 2, 'Expected one LLM and one Jev request for the selected one-skill batch'
            send({'id': 'session', 'type': 'prompt', 'message': 'Run the synthetic fixture and inspect the output.'})
            while True:
                event = get()
                if event.get('type') == 'agent_settled':
                    break
            send({'id': 'review', 'type': 'prompt', 'message': '/skill-review'})
            seen_draft = False
            while True:
                event = get()
                if event.get('type') == 'extension_ui_request':
                    method = event['method']
                    if method == 'editor':
                        if event['title'].startswith('Review and edit proposed'):
                            assert 'fixture-check' in event['prefill']
                            seen_draft = True
                        send({'type': 'extension_ui_response', 'id': event['id'], 'value': event['prefill']})
                    elif method == 'confirm':
                        send({'type': 'extension_ui_response', 'id': event['id'], 'confirmed': True})
                    elif method == 'notify' and event.get('notifyType') == 'error':
                        raise AssertionError(event['message'])
                if event.get('id') == 'review' and event.get('type') == 'response':
                    assert event.get('success'), event
                    break
            assert seen_draft, 'No skill draft displayed'
            created = agent / 'skills' / 'fixture-check' / 'SKILL.md'
            assert created.exists() and 'fixture-check' in created.read_text()
            print('Pi RPC smoke test passed: bounded batch selection, batch/preview cancellation, audit and session review with mock providers and isolated skill creation.')
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            server.shutdown()

if __name__ == '__main__':
    main()
