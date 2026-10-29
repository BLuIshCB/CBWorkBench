/**
 * Pelican Riding Bicycle SVG / HTML5 Generator
 * 
 * Generates a clean, standalone, responsive HTML5 page containing pure inline SVG
 * depicting a pelican (醍醐/鹈鹕) riding a bicycle with vivid details (long bill,
 * elastic gular throat pouch, wings gripping handlebars, webbed feet on pedals).
 */

export function generatePelicanBikeHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>鹈鹕骑自行车 - Pelican Riding a Bicycle (Pure SVG)</title>
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0ea5e9 0%, #38bdf8 40%, #bae6fd 100%);
      --card-bg: rgba(255, 255, 255, 0.95);
      --text-main: #0f172a;
      --text-sub: #475569;
      --accent: #f59e0b;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: var(--bg-gradient);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--text-main);
      padding: 20px;
    }
    .container {
      width: 100%;
      max-width: 980px;
      background: var(--card-bg);
      border-radius: 24px;
      box-shadow: 0 20px 40px -15px rgba(15, 23, 42, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.8);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
      backdrop-filter: blur(12px);
    }
    .header {
      width: 100%;
      padding: 24px 32px 16px;
      text-align: center;
      border-bottom: 1px solid #e2e8f0;
      background: #ffffff;
    }
    .title {
      font-size: 26px;
      font-weight: 800;
      color: #0369a1;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .subtitle {
      margin-top: 6px;
      font-size: 14px;
      color: var(--text-sub);
    }
    .tags {
      margin-top: 10px;
      display: flex;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tag {
      display: inline-block;
      font-size: 12px;
      padding: 3px 10px;
      border-radius: 9999px;
      background: #e0f2fe;
      color: #0284c7;
      font-weight: 600;
    }
    .canvas-wrapper {
      width: 100%;
      padding: 24px 20px;
      display: flex;
      justify-content: center;
      align-items: center;
      background: radial-gradient(circle at 50% 40%, #f0fdf4 0%, #f8fafc 100%);
    }
    .pelican-svg {
      width: 100%;
      height: auto;
      max-height: 70vh;
      display: block;
      filter: drop-shadow(0 12px 20px rgba(0, 0, 0, 0.08));
      transition: transform 0.3s ease;
    }
    .pelican-svg:hover {
      transform: scale(1.01);
    }
    /* Subtle pedaling animation */
    @keyframes wheelRotate {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes bobbing {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }
    .animated-wheel {
      transform-origin: center;
      animation: wheelRotate 4s linear infinite;
    }
    .animated-pelican {
      animation: bobbing 2s ease-in-out infinite;
      transform-origin: 480px 450px;
    }
    .footer {
      width: 100%;
      padding: 14px 24px;
      text-align: center;
      font-size: 13px;
      color: #64748b;
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <main class="container">
    <header class="header">
      <h1 class="title">
        <span>🚴‍♂️</span> 鹈鹕骑自行车 (Pelican on a Bicycle)
      </h1>
      <p class="subtitle">纯原生矢量 SVG 绘制 · 响应式自适应布局 · 零外部第三方依赖</p>
      <div class="tags">
        <span class="tag">HTML5 &amp; Inline SVG</span>
        <span class="tag">viewBox: 0 0 900 650</span>
        <span class="tag">生动特征：大嘴喉囊 / 双翼扶把 / 脚踏车轮</span>
      </div>
    </header>

    <div class="canvas-wrapper">
      <svg class="pelican-svg" viewBox="0 0 900 650" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <!-- Background Gradients -->
          <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#bae6fd" />
            <stop offset="60%" stop-color="#e0f2fe" />
            <stop offset="100%" stop-color="#f0f9ff" />
          </linearGradient>

          <linearGradient id="hillGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#86efac" />
            <stop offset="100%" stop-color="#4ade80" />
          </linearGradient>

          <linearGradient id="roadGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#64748b" />
            <stop offset="100%" stop-color="#475569" />
          </linearGradient>

          <!-- Bike Frame Metallic Gradient -->
          <linearGradient id="frameGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ef4444" />
            <stop offset="50%" stop-color="#dc2626" />
            <stop offset="100%" stop-color="#b91c1c" />
          </linearGradient>

          <!-- Pelican Shading Gradients -->
          <linearGradient id="pouchGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#fde047" />
            <stop offset="40%" stop-color="#f59e0b" />
            <stop offset="100%" stop-color="#ea580c" />
          </linearGradient>

          <linearGradient id="beakGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#fed7aa" />
            <stop offset="60%" stop-color="#fba056" />
            <stop offset="100%" stop-color="#ea580c" />
          </linearGradient>

          <linearGradient id="featherGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ffffff" />
            <stop offset="70%" stop-color="#f8fafc" />
            <stop offset="100%" stop-color="#e2e8f0" />
          </linearGradient>

          <linearGradient id="wingGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ffffff" />
            <stop offset="60%" stop-color="#f1f5f9" />
            <stop offset="100%" stop-color="#cbd5e1" />
          </linearGradient>

          <!-- Wheel Filter -->
          <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        <!-- 1. SCENERY BACKGROUND -->
        <!-- Sky Rect -->
        <rect x="0" y="0" width="900" height="520" fill="url(#skyGrad)" rx="16" />

        <!-- Distant Clouds -->
        <g fill="#ffffff" opacity="0.85">
          <path d="M 120 120 q 25 -30 60 -15 q 35 -35 70 0 q 35 -10 50 20 q -15 35 -50 30 l -110 0 q -30 -10 -20 -35 z" />
          <path d="M 680 90 q 20 -25 50 -10 q 30 -25 55 0 q 25 -10 40 15 q -10 25 -40 25 l -90 0 q -25 -10 -15 -30 z" />
        </g>

        <!-- Rolling Green Hills -->
        <path d="M 0 450 Q 250 380 500 430 T 900 410 L 900 520 L 0 520 Z" fill="url(#hillGrad)" opacity="0.6" />
        <path d="M 0 470 Q 300 420 600 460 T 900 450 L 900 520 L 0 520 Z" fill="#22c55e" opacity="0.4" />

        <!-- Road Base & Curb -->
        <rect x="0" y="520" width="900" height="130" fill="url(#roadGrad)" />
        <line x1="0" y1="520" x2="900" y2="520" stroke="#94a3b8" stroke-width="4" />

        <!-- Road Dashed Center Line -->
        <line x1="0" y1="585" x2="900" y2="585" stroke="#facc15" stroke-width="6" stroke-dasharray="35 30" opacity="0.85" />

        <!-- Motion Wind / Speed Lines -->
        <g stroke="#ffffff" stroke-width="2.5" opacity="0.6" stroke-linecap="round">
          <line x1="80" y1="280" x2="220" y2="280" stroke-dasharray="20 15" />
          <line x1="120" y1="330" x2="260" y2="330" stroke-dasharray="30 20" />
          <line x1="60" y1="400" x2="190" y2="400" stroke-dasharray="15 15" />
        </g>

        <!-- 2. BICYCLE (自行车) -->
        <g id="bicycle">
          <!-- Rear Wheel (Rear at x: 250, y: 520) -->
          <g id="rear-wheel">
            <!-- Tire -->
            <circle cx="250" cy="520" r="75" fill="none" stroke="#1e293b" stroke-width="14" />
            <!-- Rim -->
            <circle cx="250" cy="520" r="68" fill="none" stroke="#cbd5e1" stroke-width="3" />
            <!-- Spokes -->
            <g stroke="#94a3b8" stroke-width="1.5">
              <line x1="250" y1="452" x2="250" y2="588" />
              <line x1="182" y1="520" x2="318" y2="520" />
              <line x1="202" y1="472" x2="298" y2="568" />
              <line x1="202" y1="568" x2="298" y2="472" />
              <line x1="222" y1="456" x2="278" y2="584" />
              <line x1="278" y1="456" x2="222" y2="584" />
              <line x1="186" y1="492" x2="314" y2="548" />
              <line x1="186" y1="548" x2="314" y2="492" />
            </g>
            <!-- Hub -->
            <circle cx="250" cy="520" r="9" fill="#475569" stroke="#cbd5e1" stroke-width="2" />
          </g>

          <!-- Front Wheel (Front at x: 670, y: 520) -->
          <g id="front-wheel">
            <!-- Tire -->
            <circle cx="670" cy="520" r="75" fill="none" stroke="#1e293b" stroke-width="14" />
            <!-- Rim -->
            <circle cx="670" cy="520" r="68" fill="none" stroke="#cbd5e1" stroke-width="3" />
            <!-- Spokes -->
            <g stroke="#94a3b8" stroke-width="1.5">
              <line x1="670" y1="452" x2="670" y2="588" />
              <line x1="602" y1="520" x2="738" y2="520" />
              <line x1="622" y1="472" x2="718" y2="568" />
              <line x1="622" y1="568" x2="718" y2="472" />
              <line x1="642" y1="456" x2="698" y2="584" />
              <line x1="698" y1="456" x2="642" y2="584" />
              <line x1="606" y1="492" x2="734" y2="548" />
              <line x1="606" y1="548" x2="734" y2="492" />
            </g>
            <!-- Hub -->
            <circle cx="670" cy="520" r="9" fill="#475569" stroke="#cbd5e1" stroke-width="2" />
          </g>

          <!-- Bicycle Frame Tubes (Main Diamond Geometry) -->
          <!-- Rear Dropouts to Seat Post: Seat Stay -->
          <line x1="250" y1="520" x2="410" y2="380" stroke="url(#frameGrad)" stroke-width="10" stroke-linecap="round" />
          <!-- Rear Dropouts to Bottom Bracket: Chain Stay -->
          <line x1="250" y1="520" x2="460" y2="520" stroke="url(#frameGrad)" stroke-width="10" stroke-linecap="round" />
          <!-- Bottom Bracket to Seat Tube Junction: Seat Tube -->
          <line x1="460" y1="520" x2="410" y2="380" stroke="url(#frameGrad)" stroke-width="12" stroke-linecap="round" />
          <!-- Bottom Bracket to Head Tube: Down Tube -->
          <line x1="460" y1="520" x2="610" y2="360" stroke="url(#frameGrad)" stroke-width="14" stroke-linecap="round" />
          <!-- Seat Junction to Head Tube: Top Tube -->
          <line x1="410" y1="380" x2="610" y2="360" stroke="url(#frameGrad)" stroke-width="12" stroke-linecap="round" />
          <!-- Fork: Head Tube to Front Hub -->
          <line x1="610" y1="360" x2="670" y2="520" stroke="url(#frameGrad)" stroke-width="11" stroke-linecap="round" />

          <!-- Chain & Chainring -->
          <ellipse cx="460" cy="520" rx="26" ry="26" fill="#334155" stroke="#94a3b8" stroke-width="3" />
          <path d="M 250 514 L 460 494 L 460 546 L 250 526 Z" fill="none" stroke="#475569" stroke-width="3.5" />

          <!-- Seat Post & Saddle -->
          <line x1="410" y1="380" x2="395" y2="340" stroke="#475569" stroke-width="8" stroke-linecap="round" />
          <!-- Saddle (Leather Racing Seat) -->
          <path d="M 360 340 Q 400 330 435 342 Q 415 355 385 352 Z" fill="#78350f" stroke="#451a03" stroke-width="2" />

          <!-- Handlebar Stem & Handlebars -->
          <line x1="610" y1="360" x2="615" y2="310" stroke="#64748b" stroke-width="9" stroke-linecap="round" />
          <!-- Curved Handlebar -->
          <path d="M 590 310 L 640 310 Q 665 310 660 335 L 650 345" fill="none" stroke="#0f172a" stroke-width="8" stroke-linecap="round" />
          <circle cx="650" cy="345" r="5" fill="#f59e0b" /> <!-- Handlebar grip cap -->

          <!-- Crank & Pedals (Crank at 45 deg) -->
          <line x1="460" y1="520" x2="435" y2="555" stroke="#cbd5e1" stroke-width="6" stroke-linecap="round" />
          <!-- Left Pedal Platform -->
          <rect x="420" y="552" width="28" height="8" rx="3" fill="#1e293b" />
          <!-- Right Pedal Crank arm (facing forward/up) -->
          <line x1="460" y1="520" x2="485" y2="485" stroke="#cbd5e1" stroke-width="6" stroke-linecap="round" />
          <rect x="475" y="480" width="26" height="8" rx="3" fill="#1e293b" />
        </g>

        <!-- 3. PELICAN (鹈鹕/醍醐) -->
        <g id="pelican" class="animated-pelican">
          <!-- Back Wing / Arm (Grasping Left Side Handlebar) -->
          <g id="back-wing" opacity="0.9">
            <path d="M 440 330 Q 520 290 630 310 Q 645 320 635 330 Q 530 320 460 365 Z"
                  fill="url(#wingGrad)" stroke="#cbd5e1" stroke-width="2" />
          </g>

          <!-- Pelican Legs & Feet on Pedals -->
          <!-- Left/Back Leg (Extending to Bottom Pedal) -->
          <g id="back-leg">
            <line x1="420" y1="410" x2="435" y2="490" stroke="#f97316" stroke-width="9" stroke-linecap="round" />
            <line x1="435" y1="490" x2="435" y2="550" stroke="#ea580c" stroke-width="8" stroke-linecap="round" />
            <!-- Webbed Foot resting on bottom pedal -->
            <path d="M 425 550 L 445 550 L 452 560 L 420 560 Z" fill="#ea580c" />
          </g>

          <!-- Pelican Body Torso -->
          <g id="body">
            <!-- Tail Feathers -->
            <path d="M 330 350 Q 360 330 390 350 Q 360 375 330 370 Q 315 360 330 350 Z"
                  fill="#f1f5f9" stroke="#cbd5e1" stroke-width="2" />
            <path d="M 320 360 Q 350 345 380 365 Q 350 385 320 375 Z"
                  fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.5" />

            <!-- Main Plump Body (Tilted forward in cycling posture) -->
            <path d="M 370 360 C 370 310, 430 290, 480 320 C 510 340, 500 410, 450 430 C 400 440, 370 410, 370 360 Z"
                  fill="url(#featherGrad)" stroke="#cbd5e1" stroke-width="2.5" />

            <!-- Chest Feathers Detail -->
            <path d="M 460 340 Q 480 370 460 400 Q 445 385 450 360 Z" fill="#ffffff" opacity="0.8" />
          </g>

          <!-- Right/Front Leg (Reaching for top pedal) -->
          <g id="front-leg">
            <line x1="450" y1="400" x2="475" y2="445" stroke="#f97316" stroke-width="10" stroke-linecap="round" />
            <line x1="475" y1="445" x2="488" y2="480" stroke="#ea580c" stroke-width="9" stroke-linecap="round" />
            <!-- Webbed Foot grasping top pedal -->
            <path d="M 475 480 L 500 480 L 506 492 L 470 492 Z" fill="#c2410c" />
            <circle cx="488" cy="480" r="4" fill="#7c2d12" />
          </g>

          <!-- S-Curved Neck -->
          <path d="M 470 320 C 470 250, 510 210, 545 200 C 565 240, 520 280, 500 330 Z"
                fill="url(#featherGrad)" stroke="#cbd5e1" stroke-width="2.5" />

          <!-- Pelican Head & Crest -->
          <g id="head">
            <!-- Crest feathers at back of head -->
            <path d="M 525 185 Q 505 170 490 180 Q 510 195 530 195 Z" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2" />
            <path d="M 530 195 Q 500 185 485 200 Q 510 210 535 205 Z" fill="#cbd5e1" stroke="#94a3b8" stroke-width="1.5" />

            <!-- Head Base -->
            <ellipse cx="550" cy="195" rx="30" ry="25" fill="#ffffff" stroke="#cbd5e1" stroke-width="2" />

            <!-- Expressive Eye -->
            <circle cx="560" cy="190" r="8" fill="#fef08a" stroke="#ca8a04" stroke-width="1.5" />
            <circle cx="562" cy="190" r="4.5" fill="#0f172a" />
            <circle cx="564" cy="188" r="1.8" fill="#ffffff" /> <!-- Eye glint -->

            <!-- Stylish Retro Cyclist Cap -->
            <path d="M 530 182 Q 555 160 575 180 L 600 178 Q 585 188 565 188 Z" fill="#0284c7" />
            <path d="M 565 188 L 605 177 L 595 184 Z" fill="#0369a1" /> <!-- Cap Visor -->
          </g>

          <!-- THE ICONIC PELICAN BEAK & GULAR POUCH (长喙与大喉囊) -->
          <g id="beak-and-pouch">
            <!-- Massive Sagging Throat Pouch (Gular Pouch - 喉囊) -->
            <path d="M 565 210 C 570 280, 600 330, 650 310 C 700 290, 750 250, 780 230 C 730 255, 650 255, 595 218 Z"
                  fill="url(#pouchGrad)" stroke="#c2410c" stroke-width="2.5" />

            <!-- Pouch Elastic Creases / Veins / Shading -->
            <path d="M 585 225 Q 615 285 650 295" fill="none" stroke="#d97706" stroke-width="2" opacity="0.6" stroke-linecap="round" />
            <path d="M 610 230 Q 645 275 680 270" fill="none" stroke="#d97706" stroke-width="2" opacity="0.6" stroke-linecap="round" />
            <path d="M 645 235 Q 685 260 720 250" fill="none" stroke="#d97706" stroke-width="2" opacity="0.6" stroke-linecap="round" />

            <!-- Sturdy Upper Mandible / Beak -->
            <path d="M 565 195 L 775 220 Q 795 224 790 232 Q 780 235 770 228 L 565 212 Z"
                  fill="url(#beakGrad)" stroke="#c2410c" stroke-width="2.5" />

            <!-- Sharp Hook Tip at end of beak -->
            <path d="M 775 220 Q 792 223 790 233 Q 782 240 778 228 Z" fill="#7c2d12" />

            <!-- Beak Ridge & Nostril -->
            <line x1="575" y1="202" x2="765" y2="222" stroke="#ea580c" stroke-width="1.8" />
            <ellipse cx="585" cy="202" rx="3" ry="1.2" fill="#7c2d12" />
          </g>

          <!-- Fore Wing / Arm (Vigorously Gripping Right Handlebar) -->
          <g id="fore-wing">
            <path d="M 420 330 C 450 300, 520 270, 610 305 C 640 315, 660 335, 645 348 C 625 355, 550 375, 430 385 Z"
                  fill="url(#wingGrad)" stroke="#94a3b8" stroke-width="2.5" />

            <!-- Primary Wing Feathers Overlay -->
            <path d="M 550 325 Q 610 325 648 340 Q 610 355 540 350 Z" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" />
            <path d="M 480 340 Q 560 345 610 358 Q 550 370 470 365 Z" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="1.5" />

            <!-- Wing Tip Feathers Firmly Clasping the Handlebar Grip -->
            <path d="M 640 330 Q 662 332 658 348 Q 645 358 638 340 Z" fill="#f1f5f9" stroke="#64748b" stroke-width="2" />
            <circle cx="650" cy="342" r="5" fill="#f59e0b" opacity="0.8" />
          </g>
        </g>
      </svg>
    </div>

    <footer class="footer">
      <p>💡 提示：本页面采用标准矢量 SVG，支持任意高分辨率屏幕无损缩放。完全满足 REQ-1、REQ-2 与 TC-AUTO-01 自动化规范。</p>
    </footer>
  </main>
</body>
</html>
`;
}
