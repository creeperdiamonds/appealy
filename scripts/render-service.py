#!/usr/bin/env python3
"""Render deploy/service.yaml with the real image and revision name.

Every placeholder must be filled. An unrendered one would deploy a container
image literally named IMAGE_WEB, so this asserts rather than warns.

Reads from the environment, writes the result to stdout:

  ARTIFACT_REGISTRY  us-central1-docker.pkg.dev/<project>/appealy-repo
  SHA                commit to tag the image with
  REVISION           name for the new revision
  PIN_TO_REVISION    optional: leave all traffic on this revision, and give the
                     new one no traffic and the tag "next", so it can be tested
"""

import io
import os
import re
import sys

REQUIRED = ["ARTIFACT_REGISTRY", "SHA", "REVISION"]

missing = [k for k in REQUIRED if not os.environ.get(k)]
if missing:
    sys.exit("missing environment: %s" % ", ".join(missing))

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = io.open(os.path.join(here, "deploy", "service.yaml"), encoding="utf-8").read()

spec = spec.replace("IMAGE_WEB", "%s/appealy-web:%s" % (os.environ["ARTIFACT_REGISTRY"], os.environ["SHA"]))
spec = spec.replace("REVISION_NAME_VALUE", os.environ["REVISION"])

left = re.findall(r"IMAGE_[A-Z]+|[A-Z_]+_VALUE", spec)
if left:
    sys.exit("unrendered placeholder(s): %s" % ", ".join(sorted(set(left))))

pin = os.environ.get("PIN_TO_REVISION")
if pin:
    spec += (
        "  traffic:\n"
        "    - revisionName: %s\n"
        "      percent: 100\n"
        "    - revisionName: %s\n"
        "      percent: 0\n"
        "      tag: next\n" % (pin, os.environ["REVISION"])
    )

# Written as bytes, explicitly UTF-8. sys.stdout.write() encodes with the
# platform default, which on Windows is cp1252 and mangles the em-dashes in
# the spec's comments into invalid bytes. CI is Linux so it would not have
# shown up there — it would have shown up for whoever ran this locally.
sys.stdout.buffer.write(spec.encode("utf-8"))
