#!/usr/bin/env python3
"""Boot a ROM image in a headless Hatari and take timed screenshots.

Usage:
  tools/hatari_boot.py ROM [--harddrive DIR] [--disk-a IMG] [--machine ste]
                       [--memsize 4096] [--shots 5,15,30] [--label NAME]

Each run gets its own folder under tools/runs/<timestamp>-<label>/ with the
Hatari log, stdout/stderr and the screenshots (shot-<seconds>s.png). Hatari
runs with a private HOME so the user's saved configuration does not leak in.
"""
import argparse
import datetime
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HATARI = shutil.which("hatari") or "/usr/local/bin/hatari"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rom")
    ap.add_argument("--harddrive")
    ap.add_argument("--disk-a")
    ap.add_argument("--machine", default="ste")
    ap.add_argument("--memsize", default="4096")
    ap.add_argument("--monitor", default="rgb")
    ap.add_argument("--shots", default="5,15,30",
                    help="comma-separated wall-clock seconds to take screenshots at")
    ap.add_argument("--label", default="boot")
    ap.add_argument("--extra", default="", help="extra Hatari arguments")
    ap.add_argument("--keys", default="",
                    help="comma-separated SECONDS:SCANCODE key presses, e.g. 40:0x1c for Return")
    ap.add_argument("--warmreset-at", default="",
                    help="comma-separated seconds at which to send a warm reset")
    ap.add_argument("--debug-at-end", default="",
                    help="semicolon-separated debugger commands sent after the last shot "
                         "(output lands in stderr.txt)")
    args = ap.parse_args()

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = os.path.join(HERE, "runs", f"{stamp}-{args.label}")
    shots_dir = os.path.join(run_dir, "shots")
    os.makedirs(shots_dir)
    os.makedirs(os.path.join(run_dir, "home"))

    sock_dir = tempfile.mkdtemp(prefix="hb", dir="/tmp")
    sock_path = os.path.join(sock_dir, "ctl.sock")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(1)
    server.settimeout(20)

    cmd = [HATARI, "--tos", os.path.abspath(args.rom), "--machine", args.machine,
           "--memsize", args.memsize, "--ttram", "0", "--fast-boot", "false",
           "--monitor", args.monitor, "--sound", "off", "--confirm-quit", "false",
           "--fast-forward", "yes", "--statusbar", "false", "--drive-led", "false",
           "--patch-tos", "off", "--log-file", os.path.join(run_dir, "hatari.log"),
           "--screenshot-dir", shots_dir, "--control-socket", sock_path]
    if args.harddrive:
        cmd += ["--harddrive", os.path.abspath(args.harddrive)]
    if args.disk_a:
        cmd += ["--disk-a", os.path.abspath(args.disk_a)]
    if args.extra:
        cmd += args.extra.split()
    with open(os.path.join(run_dir, "command.txt"), "w") as f:
        f.write(" ".join(cmd) + "\n")

    env = dict(os.environ, HOME=os.path.join(run_dir, "home"),
               SDL_VIDEODRIVER="dummy", SDL_AUDIODRIVER="dummy")
    proc = subprocess.Popen(cmd, env=env,
                            stdout=open(os.path.join(run_dir, "stdout.txt"), "wb"),
                            stderr=open(os.path.join(run_dir, "stderr.txt"), "wb"))
    taken = []
    conn = None
    try:
        conn, _ = server.accept()
        start = time.time()
        events = [(float(s), "shot", None) for s in args.shots.split(",")]
        for k in filter(None, args.keys.split(",")):
            at, code = k.split(":")
            events.append((float(at), "key", int(code, 0)))
        for at in filter(None, args.warmreset_at.split(",")):
            events.append((float(at), "reset", None))
        for at, kind, code in sorted(events, key=lambda e: e[0]):
            delay = start + at - time.time()
            if delay > 0:
                time.sleep(delay)
            if proc.poll() is not None:
                break
            if kind == "reset":
                conn.sendall(b"hatari-shortcut warmreset\n")
                continue
            if kind == "key":
                conn.sendall(f"hatari-event keydown {code}\n".encode())
                time.sleep(0.2)
                conn.sendall(f"hatari-event keyup {code}\n".encode())
                continue
            before = set(os.listdir(shots_dir))
            conn.sendall(b"hatari-shortcut screenshot\n")
            end = time.time() + 5
            while time.time() < end:
                new = [f for f in os.listdir(shots_dir) if f not in before]
                if new:
                    time.sleep(0.2)
                    dst = os.path.join(shots_dir, f"shot-{int(at):03d}s.png")
                    os.replace(os.path.join(shots_dir, new[0]), dst)
                    taken.append(dst)
                    break
                time.sleep(0.05)
        for dbg in filter(None, (c.strip() for c in args.debug_at_end.split(";"))):
            conn.sendall(f"hatari-debug {dbg}\n".encode())
            time.sleep(0.3)
    except (socket.timeout, OSError) as err:
        print(f"harness error: {err}", file=sys.stderr)
    finally:
        if conn is not None:
            try:
                conn.sendall(b"hatari-shortcut quit\n")
            except OSError:
                pass
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.send_signal(signal.SIGKILL)
            proc.wait(5)
        shutil.rmtree(sock_dir, ignore_errors=True)

    print(f"run: {run_dir}")
    print(f"hatari exit: {proc.returncode}")
    for path in taken:
        print(f"shot: {path}")
    return 0 if taken else 1


if __name__ == "__main__":
    sys.exit(main())
