"""Fresh browser contexts; no credentials, clicks, model calls, or history export."""
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sys
import time
import urllib.request
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

base, version, phase, output = sys.argv[1:]
parsed_base = urlparse(base)
assert parsed_base.scheme == 'http' and parsed_base.port and not parsed_base.username and not parsed_base.password
assert not parsed_base.path and not parsed_base.query and not parsed_base.fragment
address = ipaddress.IPv4Address(parsed_base.hostname)
assert address == ipaddress.ip_address('127.0.0.1') or any(
    address in ipaddress.ip_network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'))


def get(path):
    # Cold status includes parallel engine version probes (each bounded to 5s).
    # Keep the request bounded without racing that legitimate probe deadline.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(base + path, timeout=30 if path == '/api/omnigent' else 5) as response:
        return json.load(response)


deadline = time.monotonic() + 150
while True:
    try:
        get('/api/home')
        break
    except Exception:
        if time.monotonic() >= deadline:
            raise RuntimeError('image did not become ready within 150 seconds') from None
        time.sleep(0.5)

views, ids = [], []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    try:
        for mobile in (False, True):
            context = browser.new_context(viewport={'width':390 if mobile else 1440,'height':844 if mobile else 900}, locale='en-US')
            page = context.new_page()
            model_requests = []
            def observe(request):
                if request.method == 'POST':
                    try:
                        if request.post_data_json.get('type') in ('prompt', 'steer', 'follow_up'):
                            model_requests.append(request.url)
                    except (AttributeError, ValueError):
                        pass
            page.on('request', observe)
            try:
                page.goto(base + '/', wait_until='domcontentloaded', timeout=30000)
                page.wait_for_url(re.compile(r'.*[?&]session=[^&]+'), timeout=35000)
                selected = parse_qs(urlparse(page.url).query)['session'][0]
                pending = get('/api/omnigent/onboarding')
                assert pending == {'pending':True,'sessionId':selected}
                prompt = page.get_by_text('啟動 Omnigent 連線設定精靈。伺服器與帳號資訊請在設定面板填寫，密碼不要貼在對話裡。', exact=True)
                prompt.wait_for(state='visible', timeout=15000)
                url = page.get_by_placeholder('https://omnigent.example.com', exact=True)
                url.wait_for(state='visible', timeout=15000)
                assert url.input_value() == ''
                view = get('/api/omnigent')
                assert view['active'] and view['version'] == version and view['loginConfirmed'] is False and view['server'] is None
                assert not model_requests
                ids.append(selected)
                views.append({'viewport':'mobile' if mobile else 'desktop','autoSelected':True,
                              'conversationVisible':True,'initialUrlPromptVisible':True,'initialUrlInputEmpty':True,
                              'modelRequests':0,'clicks':0})
            finally:
                context.close()
    finally:
        browser.close()
assert len(set(ids)) == 1
receipt = {'phase':phase,'passed':True,'views':views,'sessionHash':hashlib.sha256(ids[0].encode()).hexdigest()}
Path(output).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
