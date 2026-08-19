#!/usr/bin/env python3
"""Render deploy/service.yaml with real images and secrets.

Substitution is done here rather than with sed because the values include
generated secrets, and sed would misbehave on any / or & inside one.

Every placeholder must be filled. An unrendered one would deploy a container
image literally named IMAGE_API, or an env var whose value is the string
"TEBEX_PRIVATE_KEY_VALUE" — the first fails loudly, the second starts fine and
then fails to take payments, so this asserts rather than warns.

Reads from the environment, writes the result to stdout:

  ARTIFACT_REGISTRY  us-central1-docker.pkg.dev/<project>/appealy-repo
  SHA                commit to tag every image with
  TEBEX_PROJECT_ID / TEBEX_PRIVATE_KEY / TEBEX_WEBHOOK_SECRET
  RPC_SECRET         guards the bot's control server
"""

import io
import os
import re
import sys

REQUIRED = [
    "ARTIFACT_REGISTRY",
    "SHA",
    "TEBEX_PROJECT_ID",
    "TEBEX_PRIVATE_KEY",
    "TEBEX_WEBHOOK_SECRET",
    "RPC_SECRET",
]

missing = [k for k in REQUIRED if not os.environ.get(k)]
if missing:
    sys.exit("missing environment: %s" % ", ".join(missing))

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = io.open(os.path.join(here, "deploy", "service.yaml"), encoding="utf-8").read()

registry = os.environ["ARTIFACT_REGISTRY"]
sha = os.environ["SHA"]

for service, placeholder in (("api", "IMAGE_API"), ("web", "IMAGE_WEB"), ("bot", "IMAGE_BOT")):
    spec = spec.replace(placeholder, "%s/appealy-%s:%s" % (registry, service, sha))

for var in ("TEBEX_PROJECT_ID", "TEBEX_PRIVATE_KEY", "TEBEX_WEBHOOK_SECRET"):
    spec = spec.replace(var + "_VALUE", os.environ[var])

spec = spec.replace("INTERNAL_RPC_SECRET_VALUE", os.environ["RPC_SECRET"])

left = re.findall(r"IMAGE_[A-Z]+|[A-Z_]+_VALUE", spec)
if left:
    sys.exit("unrendered placeholder(s): %s" % ", ".join(sorted(set(left))))

# Written as bytes, explicitly UTF-8. sys.stdout.write() encodes with the
# platform default, which on Windows is cp1252 and mangles the em-dashes in
# the spec's comments into invalid bytes. CI is Linux so it would not have
# shown up there — it would have shown up for whoever ran this locally.
sys.stdout.buffer.write(spec.encode("utf-8"))
