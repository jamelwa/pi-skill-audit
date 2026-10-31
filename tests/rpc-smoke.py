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
    def log_message(self, *args):
        pass

    def do_POST(self):
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
            assert "synthetic skill" in json.dumps(body)
            text = json.dumps({"dimensions": GOOD, "evidence": ["synthetic skill"], "boundary": "Automate local processing."})
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
        skill = tmp / 'demo'
        skill.mkdir()
        (skill / 'SKILL.md').write_text('---\nname: demo\ndescription: Synthetic demo\n---\nsynthetic skill\n')
        base = f'http://127.0.0.1:{server.server_port}'
        (agent / 'models.json').write_text(json.dumps({"providers": {
            "audit-mock": {"baseUrl": base + '/v1', "api": "openai-completions", "apiKey": "fake",
                           "models": [{"id": "mock", "name": "Mock"}]},
            "typesafe": {"baseUrl": base + '/v1'},
        }}))
        env = {**os.environ, 'PI_CODING_AGENT_DIR': str(agent), 'TYPESAFE_API_KEY': 'fake'}
        proc = subprocess.Popen(['pi', '--offline', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp',
                                 '--no-skills', '--skill', str(skill), '--provider', 'audit-mock', '--model', 'mock',
                                 '-e', str(ROOT / 'extensions/skill-audit/index.ts')],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
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
        try:
            send({'id': 'commands', 'type': 'get_commands'})
            while True:
                event = get()
                if event.get('id') == 'commands':
                    assert any(c['name'] == 'skill-audit' for c in event['data']['commands'])
                    break
            send({'id': 'run', 'type': 'prompt', 'message': '/skill-audit run --mode compare'})
            seen_report = False
            while True:
                event = get()
                if event.get('type') == 'extension_ui_request':
                    method = event['method']
                    if method == 'select':
                        assert any('demo' in option for option in event['options'])
                        send({'type': 'extension_ui_response', 'id': event['id'], 'value': 'All loaded skills'})
                    elif method == 'confirm':
                        send({'type': 'extension_ui_response', 'id': event['id'], 'confirmed': event['title'] == 'Send selected skill contents?'})
                    elif method == 'editor':
                        if event['title'].startswith('Skill audit report'):
                            report = event['prefill']
                            assert 'LLM: tool candidate' in report, report
                            assert 'JEV: tool candidate' in report, report
                            seen_report = True
                        send({'type': 'extension_ui_response', 'id': event['id'], 'cancelled': True})
                    elif method == 'notify' and event.get('notifyType') == 'error':
                        raise AssertionError(event['message'])
                if event.get('id') == 'run' and event.get('type') == 'response':
                    assert event.get('success'), event
                    break
            assert seen_report, 'No report displayed'
            print('Pi RPC smoke test passed: discovery, consent, mock LLM and Jev, report.')
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            server.shutdown()

if __name__ == '__main__':
    main()
