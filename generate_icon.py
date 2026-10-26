from PIL import Image, ImageDraw, ImageFont
import random

random.seed(20261026)
S = 1024
img = Image.new('RGB', (S, S), (205, 24, 28))

texture = Image.new('RGBA', (S, S), (0, 0, 0, 0))
td = ImageDraw.Draw(texture)
for _ in range(2600):
    x = random.randrange(S); y = random.randrange(S)
    a = random.randint(3, 14)
    c = (255, 90, 70, a) if random.random() < 0.55 else (80, 0, 0, a)
    r = random.choice([1, 1, 2, 3, 5])
    td.ellipse((x-r, y-r, x+r, y+r), fill=c)
img = Image.alpha_composite(img.convert('RGBA'), texture)

ink = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(ink)
for _ in range(75):
    x = random.randint(70, 950); y = random.randint(60, 960)
    if 230 < x < 810 and 150 < y < 870 and random.random() < 0.72:
        continue
    r = random.choice([3, 5, 8, 12, 18, 26])
    d.ellipse((x-r*2, y-r, x+r*2, y+r), fill=(8, 7, 8, random.randint(100, 220)))
for _ in range(26):
    x = random.choice([random.randint(40, 210), random.randint(800, 980)])
    y = random.randint(120, 920)
    d.line((x, y, x+random.randint(-100,100), y+random.randint(-50,50)), fill=(5,5,6,180), width=random.randint(2,8))
for _ in range(18):
    x = random.randint(90, 930); y = random.randint(30, 940)
    d.line((x, y, x+random.randint(-40,40), y+random.randint(30,180)), fill=(7,6,7,random.randint(80,170)), width=random.randint(2,9))

font = ImageFont.truetype('/System/Library/Fonts/STHeiti Medium.ttc', 730)
mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(mask)
b = md.textbbox((0, 0), '等', font=font, stroke_width=3)
tw, th = b[2]-b[0], b[3]-b[1]
md.text(((S-tw)//2-b[0], (S-th)//2-b[1]-15), '等', font=font, fill=255, stroke_width=8, stroke_fill=255)

pix = mask.load()
for _ in range(2600):
    x = random.randrange(120, 910); y = random.randrange(100, 920)
    if pix[x, y] > 0 and random.random() < 0.7:
        rr = random.choice([1, 1, 2, 3, 5])
        ImageDraw.Draw(mask).ellipse((x-rr, y-rr, x+rr, y+rr), fill=random.randint(0, 70))

char = Image.new('RGBA', (S, S), (0, 0, 0, 0))
char.paste((7, 7, 8, 255), (0, 0, S, S), mask)
ink = Image.alpha_composite(ink, char)

cut = ImageDraw.Draw(ink)
for _ in range(18):
    x = random.randint(200, 800); y = random.randint(180, 850)
    cut.line((x, y, x+random.randint(15,90), y+random.randint(-4,4)), fill=(205,24,28,random.randint(30,80)), width=random.randint(1,4))

d = ImageDraw.Draw(ink)
for _ in range(24):
    x = random.randint(55, 970); y = random.randint(50, 970)
    r = random.choice([2, 3, 4, 5, 7])
    d.ellipse((x-r*2, y-r, x+r*2, y+r), fill=(250, 246, 235, random.randint(180, 240)))
for _ in range(6):
    x = random.randint(100, 920); y = random.randint(120, 900)
    d.line((x, y, x+random.randint(20,90), y+random.randint(-20,20)), fill=(250,245,235,220), width=random.randint(2,4))

img = Image.alpha_composite(img, ink).convert('RGB')
img.save('generated_icon.png', quality=95)
