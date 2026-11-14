"""Petit serveur local pour PFP Modifier.

Usage :  python serveur.py   (puis ouvrir l'adresse affichée)
L'adresse « réseau local » permet d'ouvrir l'app sur l'iPhone (même Wi-Fi).
"""
import http.server
import os
import socket
import socketserver

PORT = int(os.environ.get("PORT", "8000"))
os.chdir(os.path.dirname(os.path.abspath(__file__)))


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # aucun paquet n'est envoyé
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".onnx": "application/octet-stream",
        ".json": "application/json",
        ".bin": "application/octet-stream",
    }


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as httpd:
    print(f"\n  Sur cet ordinateur : http://localhost:{PORT}")
    print(f"  Sur l'iPhone (même Wi-Fi) : http://{lan_ip()}:{PORT}\n")
    print("  Ctrl+C pour arrêter.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
