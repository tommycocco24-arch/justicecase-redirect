"""Deploy gate for justicecase.ai: the site goes live only if every check here passes.

Runs in GitHub Actions before each deploy (.github/workflows/deploy.yml). Standard library only.

Checks:
- only expected file types are published (no executables, archives, or unknown files)
- every HTML page carries the strict Content-Security-Policy: nothing loads from outside the
  site except Google's sign-in and database hosts, and only when sign-in is configured
- no inline <script> code, no external <script src>, no inline event handlers (onclick=...)
- nothing that looks like a secret (API keys, tokens, private keys) anywhere
- videos are only MP4s, under GitHub's size limit
- the number of case pages doesn't drop sharply compared with what's live now
"""

from __future__ import annotations

import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
ALLOWED_SUFFIXES = {".html", ".css", ".js", ".json", ".txt", ".xml", ".mp4", ".md", ""}
ALLOWED_NAMES_WITHOUT_SUFFIX = {"CNAME", ".gitignore", ".nojekyll"}
SKIP_DIRS = {".git", ".github"}
# The only origins a page may reach beyond the site itself (Firebase sign-in and sync, when on).
FIREBASE_ORIGINS = {
    "https://apis.google.com", "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com", "https://firestore.googleapis.com",
}
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),            # OpenAI / Anthropic style keys
    re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}"),
    re.compile(r"ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\"refresh_token\"\s*:"),
    re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\."),  # JWTs
]
# A Firebase web config's apiKey is public by design (protected by the Firestore rules), so a
# Google API key is allowed only inside the Firebase config attribute.
GOOGLE_KEY = re.compile(r"AIza[0-9A-Za-z_-]{35}")
MAX_VIDEO_BYTES = 95 * 1024 * 1024
MAX_CASE_DROP = 0.10  # refuse to deploy if more than 10% of live case pages would disappear

problems: list[str] = []


def fail(message: str) -> None:
    problems.append(message)


def files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            yield Path(dirpath) / name


def csp_sources(policy: str) -> dict[str, list[str]]:
    out = {}
    for part in policy.split(";"):
        tokens = part.split()
        if tokens:
            out[tokens[0]] = tokens[1:]
    return out


def check_html(path: Path, text: str) -> None:
    rel = path.relative_to(ROOT)
    m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', text)
    if not m:
        fail(f"{rel}: no Content-Security-Policy")
        return
    policy = csp_sources(m.group(1))
    if policy.get("default-src") != ["'none'"]:
        fail(f"{rel}: CSP default-src must be 'none'")
    for directive in ("script-src", "connect-src", "frame-src", "style-src", "img-src", "font-src", "media-src"):
        for source in policy.get(directive, []):
            if source in ("'self'", "'none'"):
                continue
            if directive in ("script-src", "connect-src") and source in FIREBASE_ORIGINS:
                continue
            if directive == "frame-src" and re.fullmatch(r"https://[a-z0-9-]+\.firebaseapp\.com", source):
                continue
            fail(f"{rel}: CSP {directive} allows {source}")
    if "'unsafe-inline'" in m.group(1) or "'unsafe-eval'" in m.group(1):
        fail(f"{rel}: CSP allows unsafe-inline or unsafe-eval")
    for tag in re.findall(r"<script\b[^>]*>", text, re.I):
        src = re.search(r'\bsrc="([^"]*)"', tag)
        if not src:
            fail(f"{rel}: inline <script> without src")
        elif re.match(r"(?i)(https?:)?//", src.group(1)):
            fail(f"{rel}: external script {src.group(1)}")
    for script in re.findall(r"<script\b[^>]*>(.*?)</script>", text, re.I | re.S):
        if script.strip():
            fail(f"{rel}: inline script code")
    if re.search(r"<[a-z][^>]*\son[a-z]+\s*=", text, re.I):
        fail(f"{rel}: inline event handler (on...=)")
    if re.search(r"<(iframe|object|embed)\b", text, re.I):
        fail(f"{rel}: iframe/object/embed element")


def live_case_count() -> int | None:
    try:
        with urllib.request.urlopen("https://justicecase.ai/sitemap.xml", timeout=20) as response:
            return len(re.findall(r"/cases/[a-z0-9-]+/", response.read().decode("utf-8", "replace")))
    except Exception as exc:  # first deploy, or the site is down: don't block on this check alone
        print(f"note: couldn't read the live sitemap ({exc}); skipping the case-count check")
        return None


def main() -> int:
    for path in files():
        rel = path.relative_to(ROOT)
        if path.suffix.lower() not in ALLOWED_SUFFIXES or (not path.suffix and path.name not in ALLOWED_NAMES_WITHOUT_SUFFIX):
            fail(f"{rel}: unexpected file type")
            continue
        if " " in str(rel):
            fail(f"{rel}: space in a published path (likely an iCloud duplicate)")
            continue
        if path.is_symlink():
            fail(f"{rel}: symlink")
            continue
        if path.suffix == ".mp4":
            if rel.parts[0] != "videos":
                fail(f"{rel}: videos belong in videos/")
            if path.stat().st_size > MAX_VIDEO_BYTES:
                fail(f"{rel}: video over {MAX_VIDEO_BYTES // 2**20} MB")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                fail(f"{rel}: looks like it contains a secret ({pattern.pattern[:30]}...)")
        for key in GOOGLE_KEY.finditer(text):
            context = text[max(0, key.start() - 400):key.start()]
            if "data-firebase" not in context and path.name != "firebase-config.json":
                fail(f"{rel}: Google API key outside the Firebase web config")
        if path.suffix == ".html":
            check_html(path, text)

    new_cases = len([p for p in (ROOT / "cases").iterdir() if p.is_dir()]) if (ROOT / "cases").exists() else 0
    live = live_case_count()
    if live and new_cases < live * (1 - MAX_CASE_DROP):
        fail(f"case pages would drop from {live} live to {new_cases}")
    print(f"checked {sum(1 for _ in files())} files; {new_cases} case pages (live: {live})")

    for p in problems:
        print(f"::error::{p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
