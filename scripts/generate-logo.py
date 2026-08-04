#!/usr/bin/env python3
"""
Generate Ollama Forge logo assets from SVG source.
Requires: cairosvg  (pip install cairosvg)
  or just open logo.svg in a browser and export to PNG manually.

Outputs:
  images/logo.png        — 1024x1024 extension icon
  images/banner.png      — 1280x640 marketplace banner
"""

import os
import sys

LOGO_SVG = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"
     width="1024" height="1024">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#0f1923"/>
      <stop offset="100%" stop-color="#080d13"/>
    </radialGradient>
    <radialGradient id="gemGrad" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#67e8f9"/>
      <stop offset="100%" stop-color="#0891b2"/>
    </radialGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="gemglow">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Background circle -->
  <circle cx="100" cy="100" r="100" fill="url(#bgGrad)"/>

  <!-- Outer hex frame - top corners -->
  <polyline points="62,42 50,55 50,75" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
  <polyline points="138,42 150,55 150,75" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
  <!-- Outer hex frame - bottom corners -->
  <polyline points="50,125 50,145 62,158" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
  <polyline points="150,125 150,145 138,158" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>

  <!-- Blade -->
  <line x1="100" y1="15" x2="100" y2="185" stroke="#1e3a5f" stroke-width="8" stroke-linecap="round"/>
  <line x1="100" y1="15" x2="100" y2="185" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" opacity="0.6"/>

  <!-- Top pommel -->
  <rect x="86" y="12" width="28" height="16" rx="4" fill="#1e293b" stroke="#38bdf8" stroke-width="2"/>

  <!-- Hex gem frame -->
  <polygon points="100,52 124,66 124,94 100,108 76,94 76,66"
           fill="none" stroke="#38bdf8" stroke-width="3" filter="url(#glow)"/>

  <!-- Inner gem -->
  <polygon points="100,62 116,80 100,98 84,80"
           fill="url(#gemGrad)" stroke="#67e8f9" stroke-width="1.5"
           filter="url(#gemglow)" opacity="0.9"/>

  <!-- Circuit traces left -->
  <polyline points="76,80 55,80 45,70" fill="none" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="45" y1="70" x2="30" y2="70" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="30" cy="70" r="5" fill="#38bdf8" opacity="0.8"/>

  <polyline points="76,90 58,90 48,100" fill="none" stroke="#1e3a5f" stroke-width="2" stroke-linecap="round"/>
  <circle cx="48" cy="100" r="4" fill="#0891b2" opacity="0.7"/>

  <polyline points="76,70 58,70 50,62" fill="none" stroke="#1e3a5f" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="50" cy="62" r="3.5" fill="#0891b2" opacity="0.6"/>

  <!-- Circuit traces right -->
  <polyline points="124,80 145,80 155,70" fill="none" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="155" y1="70" x2="170" y2="70" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="170" cy="70" r="5" fill="#38bdf8" opacity="0.8"/>

  <polyline points="124,90 142,90 152,100" fill="none" stroke="#1e3a5f" stroke-width="2" stroke-linecap="round"/>
  <circle cx="152" cy="100" r="4" fill="#0891b2" opacity="0.7"/>

  <polyline points="124,70 142,70 150,62" fill="none" stroke="#1e3a5f" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="150" cy="62" r="3.5" fill="#0891b2" opacity="0.6"/>
</svg>
"""

BANNER_SVG = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640"
     width="1280" height="640">
  <defs>
    <radialGradient id="bgGrad" cx="20%" cy="50%" r="70%">
      <stop offset="0%" stop-color="#0f1923"/>
      <stop offset="100%" stop-color="#080d13"/>
    </radialGradient>
    <radialGradient id="gemGrad" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#67e8f9"/>
      <stop offset="100%" stop-color="#0891b2"/>
    </radialGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="gemglow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="1280" height="640" fill="url(#bgGrad)"/>

  <!-- Subtle grid lines -->
  <g stroke="#0f2038" stroke-width="1" opacity="0.5">
    <line x1="0" y1="160" x2="1280" y2="160"/>
    <line x1="0" y1="320" x2="1280" y2="320"/>
    <line x1="0" y1="480" x2="1280" y2="480"/>
    <line x1="320" y1="0" x2="320" y2="640"/>
    <line x1="640" y1="0" x2="640" y2="640"/>
    <line x1="960" y1="0" x2="960" y2="640"/>
  </g>

  <!-- Logo group, centered left at x=200 -->
  <g transform="translate(200,320) scale(1.4)">
    <!-- Outer hex frame -->
    <polyline points="-62,-88 -80,-68 -80,-38" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
    <polyline points="62,-88 80,-68 80,-38" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
    <polyline points="-80,38 -80,68 -62,88" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
    <polyline points="80,38 80,68 62,88" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
    <!-- Blade -->
    <line x1="0" y1="-115" x2="0" y2="115" stroke="#1e3a5f" stroke-width="8" stroke-linecap="round"/>
    <line x1="0" y1="-115" x2="0" y2="115" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
    <!-- Pommel -->
    <rect x="-18" y="-122" width="36" height="16" rx="4" fill="#1e293b" stroke="#38bdf8" stroke-width="2"/>
    <!-- Hex gem frame -->
    <polygon points="0,-68 32,-48 32,-18 0,2 -32,-18 -32,-48"
             fill="none" stroke="#38bdf8" stroke-width="3" filter="url(#glow)"/>
    <!-- Inner gem -->
    <polygon points="0,-58 22,-33 0,-8 -22,-33"
             fill="url(#gemGrad)" stroke="#67e8f9" stroke-width="1.5"
             filter="url(#gemglow)" opacity="0.9"/>
    <!-- Circuit left -->
    <polyline points="-32,-33 -60,-33 -72,-45" fill="none" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="-72" y1="-45" x2="-88" y2="-45" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="-88" cy="-45" r="5" fill="#38bdf8" opacity="0.8"/>
    <polyline points="-32,-23 -55,-23 -65,-13" fill="none" stroke="#1e3a5f" stroke-width="2" stroke-linecap="round"/>
    <circle cx="-65" cy="-13" r="4" fill="#0891b2" opacity="0.7"/>
    <!-- Circuit right -->
    <polyline points="32,-33 60,-33 72,-45" fill="none" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="72" y1="-45" x2="88" y2="-45" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="88" cy="-45" r="5" fill="#38bdf8" opacity="0.8"/>
    <polyline points="32,-23 55,-23 65,-13" fill="none" stroke="#1e3a5f" stroke-width="2" stroke-linecap="round"/>
    <circle cx="65" cy="-13" r="4" fill="#0891b2" opacity="0.7"/>
  </g>

  <!-- Text: Ollama Forge -->
  <text x="480" y="290" font-family="'Segoe UI', system-ui, sans-serif"
        font-size="88" font-weight="700" fill="#f1f5f9" letter-spacing="-2">
    Ollama Forge
  </text>
  <!-- Tagline -->
  <text x="482" y="360" font-family="'Segoe UI', system-ui, sans-serif"
        font-size="32" font-weight="400" fill="#64748b" letter-spacing="1">
    Local AI coding agent · 100% offline
  </text>
  <!-- Accent line under title -->
  <line x1="482" y1="308" x2="920" y2="308" stroke="#0891b2" stroke-width="2" opacity="0.6"/>
</svg>
"""

os.makedirs("images", exist_ok=True)

# Write SVG sources
with open("images/logo.svg", "w") as f:
    f.write(LOGO_SVG.strip())
print("✓ images/logo.svg written")

with open("images/banner.svg", "w") as f:
    f.write(BANNER_SVG.strip())
print("✓ images/banner.svg written")

# Try to render PNGs with cairosvg
try:
    import cairosvg
    cairosvg.svg2png(url="images/logo.svg", write_to="images/logo.png", output_width=1024, output_height=1024)
    print("✓ images/logo.png rendered (1024x1024)")
    cairosvg.svg2png(url="images/banner.svg", write_to="images/banner.png", output_width=1280, output_height=640)
    print("✓ images/banner.png rendered (1280x640)")
except ImportError:
    print()
    print("cairosvg not installed — SVG files written, render manually:")
    print("  Option A: pip install cairosvg && python3 scripts/generate-logo.py")
    print("  Option B: open images/logo.svg and images/banner.svg in a browser,")
    print("            screenshot/export to PNG at the correct dimensions")
    print()
    print("Or install Inkscape and run:")
    print("  inkscape images/logo.svg --export-png=images/logo.png -w 1024 -h 1024")
    print("  inkscape images/banner.svg --export-png=images/banner.png -w 1280 -h 640")
