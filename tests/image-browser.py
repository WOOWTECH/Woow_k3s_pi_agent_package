"""Fresh browser contexts verify Settings-only pairing without model calls."""
import ipaddress
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
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

views = []
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
                page.wait_for_timeout(1500)
                assert 'session' not in parse_qs(urlparse(page.url).query), 'home must not open a setup conversation'
                assert page.get_by_role('button', name=re.compile('Paseo', re.I)).count() == 0, 'home must not show a Paseo shortcut'
                assert page.get_by_role('link', name=re.compile('Paseo', re.I)).count() == 0, 'home must not show a Paseo link'
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                try:
                    opener.open(base + '/api/omnigent/onboarding', timeout=5)
                except urllib.error.HTTPError as error:
                    assert error.code == 404, f'legacy onboarding API returned {error.code}'
                else:
                    raise AssertionError('legacy onboarding API is still available')
                view = get('/api/omnigent')
                assert view['active'] and view['version'] == version and view['loginConfirmed'] is False and view['server'] is None
                assert 'onboardingUrl' not in view
                assert not model_requests
                page.goto(base + '/?cwd=%2Fdata%2Fpi-agent%2Fhome&settings=plugins', wait_until='domcontentloaded')
                paseo_tab = page.get_by_role('button', name='Paseo', exact=True)
                paseo_tab.wait_for(state='visible', timeout=15000)
                paseo_tab.click()
                page.get_by_role('region', name='Paseo 連線設定').wait_for(state='visible', timeout=20000)
                assert 'session' not in parse_qs(urlparse(page.url).query)
                assert not model_requests
                views.append({'viewport':'mobile' if mobile else 'desktop','homeUnchanged':True,
                              'paseoShortcutAbsent':True,'settingsBindingVisible':True,
                              'modelRequests':0,'pairingClicks':0})
            finally:
                context.close()
    finally:
        browser.close()
receipt = {'phase':phase,'passed':True,'views':views}
Path(output).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
