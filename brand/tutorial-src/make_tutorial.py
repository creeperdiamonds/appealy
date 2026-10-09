"""
brand/tutorial-src/make_tutorial.py

Builds the "give Appealy Manage Webhooks" guide shown under the dashboard's
updates-channel picker (web/src/components/UpdatesRequirement.tsx) from plain
Discord screenshots in this folder. Re-run after replacing a screenshot:

    python brand/tutorial-src/make_tutorial.py

Writes web/public/tutorial/webhooks-step-{1,2,3}.png. Highlight positions are
in the original screenshot's pixels, so a new screenshot needs new boxes.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "web" / "public" / "tutorial"

BG = (30, 31, 34)
TEXT = (242, 243, 245)
DIM = (181, 186, 193)
MARK = (255, 197, 49)  # highlight: readable on Discord's dark grey
BADGE = (88, 101, 242)  # Discord blurple
PAD = 28
WIDTH = 720  # every step the same width, so they stack neatly

FONT_DIR = Path("C:/Windows/Fonts")


def font(bold: bool, size: int) -> ImageFont.FreeTypeFont:
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    try:
        return ImageFont.truetype(str(FONT_DIR / name), size)
    except OSError:
        return ImageFont.load_default(size)


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def step(n: int, title: str, note: str, shot: str, scale: float, boxes: list[tuple], out: str) -> None:
    """boxes: (x0, y0, x1, y1, label or None, label side 'left'|'right'|'below')."""
    src = Image.open(HERE / shot).convert("RGBA")
    shot_img = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)

    title_f, note_f, label_f = font(True, 28), font(False, 20), font(True, 18)
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    text_x = PAD + 56
    title_lines = wrap(probe, title, title_f, WIDTH - text_x - PAD)
    note_lines = wrap(probe, note, note_f, WIDTH - text_x - PAD) if note else []
    header_h = len(title_lines) * 36 + (len(note_lines) * 28 + 6 if note_lines else 0)
    header_h = max(header_h, 44)

    # Room under the screenshot for a label that sits below a box.
    below = 48 if any(b[5] == "below" for b in boxes) else 0
    shot_x = (WIDTH - shot_img.width) // 2
    shot_y = PAD + header_h + 22
    height = shot_y + shot_img.height + below + PAD

    canvas = Image.new("RGBA", (WIDTH, height), BG + (255,))
    canvas.alpha_composite(shot_img, (shot_x, shot_y))

    # Glow first, on its own layer, then the crisp outline over it.
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    rects = []
    for x0, y0, x1, y1, *_ in boxes:
        r = (shot_x + x0 * scale - 6, shot_y + y0 * scale - 6, shot_x + x1 * scale + 6, shot_y + y1 * scale + 6)
        rects.append(r)
        gd.rounded_rectangle(r, radius=12, outline=MARK + (190,), width=10)
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(7)))

    d = ImageDraw.Draw(canvas)
    for r in rects:
        d.rounded_rectangle(r, radius=12, outline=MARK + (255,), width=4)

    for r, (*_, label, side) in zip(rects, boxes):
        if not label:
            continue
        tw = d.textlength(label, font=label_f)
        pw, ph = tw + 24, 32
        if side == "right":
            px, py = r[2] + 14, (r[1] + r[3]) / 2 - ph / 2
        elif side == "left":
            px, py = r[0] - 14 - pw, (r[1] + r[3]) / 2 - ph / 2
        else:
            px, py = (r[0] + r[2]) / 2 - pw / 2, r[3] + 10
        px = max(8, min(WIDTH - pw - 8, px))
        d.rounded_rectangle((px, py, px + pw, py + ph), radius=16, fill=MARK + (255,))
        d.text((px + 12, py + 4), label, font=label_f, fill=(24, 25, 28))

    # Step number and words.
    d.ellipse((PAD, PAD, PAD + 42, PAD + 42), fill=BADGE + (255,))
    num = str(n)
    d.text((PAD + 21 - d.textlength(num, font=title_f) / 2, PAD + 2), num, font=title_f, fill=TEXT)
    y = PAD
    for line in title_lines:
        d.text((text_x, y), line, font=title_f, fill=TEXT)
        y += 36
    if note_lines:
        y += 6
        for line in note_lines:
            d.text((text_x, y), line, font=note_f, fill=DIM)
            y += 28

    OUT.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(OUT / out, optimize=True)
    print("wrote", OUT / out, canvas.size)


step(
    1,
    "Open the channel's settings",
    "Hover the channel you picked for updates and click the gear (Edit Channel).",
    "21.png",
    2.5,
    [(239, 23, 262, 46, "Edit Channel", "below")],
    "webhooks-step-1.png",
)
step(
    2,
    "Go to Permissions",
    None,
    "22.png",
    2.0,
    [(22, 80, 232, 106, None, "right")],
    "webhooks-step-2.png",
)
step(
    3,
    "Select Appealy and turn on Manage Webhooks",
    "Not in the list? Click + next to Roles/Members and add Appealy first. Then save.",
    "20.png",
    1.0,
    [
        (4, 136, 190, 162, "1. Appealy", "below"),
        (552, 384, 584, 410, "2. Allow", "below"),
    ],
    "webhooks-step-3.png",
)
