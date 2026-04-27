#!/usr/bin/env python3
"""
Oref Home Proxy — Runs on your home PC (Israeli IP).
Fetches alerts from Pikud HaOref and serves them locally.
Cloudflare Tunnel exposes this to the internet.

Run: python3 home-proxy.py
"""
import http.server
import urllib.request
import json
import ssl

PORT = 8787

ENDPOINTS = {
    '/alerts': 'https://www.oref.org.il/warningMessages/alert/alerts.json',
    '/history': 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
}

HEADERS = {
    'Referer': 'https://www.oref.org.il/',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
}

class OrefProxy(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ENDPOINTS:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Not found', 'endpoints': list(ENDPOINTS.keys())}).encode())
            return

        url = ENDPOINTS[self.path]
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

if __name__ == '__main__':
    server = http.server.HTTPServer(('127.0.0.1', PORT), OrefProxy)
    print(f"🚀 Oref Proxy running on http://127.0.0.1:{PORT}")
    print(f"   /alerts  → real-time alerts")
    print(f"   /history → alerts history")
    print(f"   Waiting for Cloudflare Tunnel...")
    server.serve_forever()
