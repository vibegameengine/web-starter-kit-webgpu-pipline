# Water — база знаний и архитектура для лагуны диорамы

Цель: вода уровня `threejsroadmap.com` Water Pro / Tidewater / Sea of Thieves, в кадре
референса `concepts/beach.png` (мелкая прозрачная тропическая лагуна, бирюзовый
градиент по глубине, кружево пены у берега и вокруг камней, каустика на дне, блики
солнца), внутри нашего пайплайна (`features/lighting-pipeline`: MRT scene pass →
composite с surfel GI → FXAA; вода вне GI).

## 1. Что делают лучшие (по источникам)

| Техника | Кто | Суть | Наш вывод |
| --- | --- | --- | --- |
| **FFT-волны, 3 каскада** (16/64/256 м), спектр Tessendorf/JONSWAP/TMA, choppiness (горизонтальное смещение) | Tidewater, Water Pro, Sea of Thieves, Ryan «Ocean Rendering» | Высотное поле + смещение по x/z из спектра; нормали из аналитических производных, а не из bump-карты | Для 12-метровой лагуны без ветра FFT избыточен: **Герстнер (4–6 волн)** даёт те же производные аналитически; каскады не нужны. FFT — вариант для «открытого моря» позже |
| **Якобиан смещения → пена гребней** | Tessendorf; Tidewater («whitecaps break where the face steepens, not where a noise texture is white»); Ryan | `J = (1+∂ηx/∂x)(1+∂ηy/∂y) − ∂ηy/∂x·∂ηx/∂y`; `J < bias` ⇒ поверхность складывается ⇒ пена. Пена копится линейно, гаснет экспоненциально в **персистентной текстуре** | Реализуем аналитический Якобиан Герстнера в вершинном/фрагментном шейдере; персистентное поле пены — этап 2 |
| **Контактная и береговая пена по depth-буферу** | Sea of Thieves (окно вокруг камеры, сравнение глубин), Cyanilux «Depth-Based Shoreline», UE Single Layer Water study, Water Pro | Глубина воды в пикселе = позиция дна (реконструкция из depth) минус уровень воды; малая глубина ⇒ пена; автоматически даёт пену вокруг любых объектов в воде | **Ключевое изменение**: вода рисуется отдельным проходом ПОСЛЕ opaque, читает depth и цвет сцены. Тогда камни в воде получают контактную пену и истинную глубину, а не аналитическую высоту песка |
| **Персистентное поле пены с feedback** | Sea of Thieves (progressive blur с feedback), Tidewater («persistent foam field: born where the surface folds, linger in streaks»), Water Pro «dynamic foam», Fluid Flux («advected foam») | Каждый кадр: `foam = max(decay · blur(prev, сдвиг по течению), sources)`; источники: Якобиан, гребни, берег, контакт с объектами, кильватер | Этап 2: RT 1024² в XZ плиты, ping-pong, источники из Якобиана + текстуры высот (с камнями) |
| **Single Layer Water** (UE) | UE water plugin, Jettelly study | Один слой: поглощение + рассеяние + отражение + рефракция + тень в одном шейдере, дешевле прозрачности | Наш проход воды — именно этот слой: opaque-материал, композит внутри |
| **Поглощение по каналам (Beer–Lambert) + in-scattering** | Water Pro («color absorbs with depth»), Tidewater («per-channel extinction on whatever sits under the water»), UE | `T = exp(−σa · путь)`, `цвет = сцена(рефракция)·T + C_scatter·(1 − exp(−σs·путь))·свет` | Путь = расстояние от точки поверхности до реконструированного дна вдоль луча зрения (истинный, из depth); заменяет наш рэймарч по heightmap |
| **Экранная рефракция с отбраковкой** | Catlike «Looking Through Water», Water Pro, UE | UV сцены + нормаль·k/глубина; если выборка «выше воды» (объект перед поверхностью) — вернуть неискажённый UV | Обязательно, иначе камни «затекают» в воду |
| **Френель + окружение + SSR** | Water Pro (SSR), Tidewater («sky mirrored per facet from the live environment map») | Schlick F0≈0.02; отражение неба из HDR; SSR для объектов | Этап 1: HDR-небо по Френелю (есть); SSR — этап 3 |
| **GGX-блик солнца с фильтрацией шероховатости + glitter** | Tidewater («distance-filtered roughness and glitter») | Низкая roughness + микронормали; искры — порог по высокочастотному шуму | Roughness 0.06–0.1 + шум нормалей; искры через NdotH-порог |
| **Каустика на дне** | Water Course, Tidewater («caustics on the sand… go dark under hulls from a sun-occlusion map»), Fluid Flux | Проекция анимированной сети (Worley/Voronoi, 2 слоя) на реконструированную позицию дна; затухает с глубиной; только под водой | Переносим каустику из sand-шейдера в проход воды: тогда она ложится и на камни, и только под водой, и умножает уже отрефрагированный цвет |
| **Маска гребня → subsurface** | Sea of Thieves (wave peak mask из choppiness: тоньше вода ⇒ больше света насквозь) | Гребень светится изнутри бирюзовым | Добавка: `peak = max(0, высота Герстнера)/A` ⇒ + scatterColor · peak · солнце |
| **Shoaling/берег** | Tidewater («shoals, breaks at H/h = 0.78, washes up a wet-sand band»), Cyanilux Shoreline | Амплитуда растёт, длина волны падает при уменьшении глубины; волна разбивается при H/h≈0.78; накат оставляет мокрый песок | Амплитуда Герстнера × f(глубина) из текстуры высот; мокрая полоса уже есть в sand-шейдере |
| **Клипмап/радиальный LOD** | Tidewater, Water Pro | Плотная сетка у камеры | Не нужно для 12 м: сетка 192×192 (6 см) |
| **Подводная камера, Snell's window, god rays** | Tidewater | — | Вне референса |

Источники: [Three.js Water Pro](https://threejsroadmap.com/assets/threejs-water-pro),
[Tidewater](https://gettidewater.com/),
[The Technical Art of Sea of Thieves (SIGGRAPH 2018)](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf),
[Ryan — Ocean Rendering Part 1](https://rtryan98.github.io/2025/10/04/ocean-rendering-part-1.html),
[GPU Gems ch.1 — Gerstner](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models),
[Cyanilux — Shoreline](https://www.cyanilux.com/tutorials/shoreline-shader-breakdown/),
[Cyanilux — Water](https://www.cyanilux.com/tutorials/water-shader-breakdown/),
[Catlike Coding — Looking Through Water](https://catlikecoding.com/unity/tutorials/flow/looking-through-water/),
[Jettelly — UE Single Layer Water study](https://jettelly.com/blog/a-water-shader-study-in-unreal-engine-using-single-layer-water),
[Fluid Flux](https://80.lv/articles/fluid-flux-a-cool-water-simulation-system-for-unreal-engine).

## 2. Формулы

**Герстнер** (GPU Gems 1, гл. 1), волна i с направлением D, амплитудой A, частотой
w = 2π/λ, фазой φ = c·w, крутизной Q (0..1/(w·A·N)):

```
P(x,z,t) = (x + Σ Q_i A_i D_i.x cos(θ_i), Σ A_i sin(θ_i), z + Σ Q_i A_i D_i.z cos(θ_i)),  θ_i = w_i·(D_i·(x,z)) + φ_i·t
∂P/∂x = (1 − Σ Q w A D.x² sin θ,  Σ w A D.x cos θ,  −Σ Q w A D.x D.z sin θ)
∂P/∂z = (−Σ Q w A D.x D.z sin θ,  Σ w A D.z cos θ,  1 − Σ Q w A D.z² sin θ)
N = normalize(∂P/∂z × ∂P/∂x)  (для +Y вверх: N = (−Σ D.x w A cos θ, 1 − Σ Q w A sin θ, −Σ D.z w A cos θ))
J = (∂P/∂x).x · (∂P/∂z).z − (∂P/∂x).z · (∂P/∂z).x      // < 0 ⇒ складка ⇒ пена
```

**Глубина из depth-буфера** (three TSL): `viewZ = perspectiveDepthToViewZ(d, near, far)`;
`P_view = getViewPosition(uv, d, cameraProjectionMatrixInverse)`; `P_world = cameraWorldMatrix · P_view`.
Вертикальная глубина `h = level − P_world.y`; путь `L = |P_surface − P_world|`.

**Рефракция**: `uv' = uv + N_view.xy · k / max(1, −viewZ_surface)`; если
`viewZ_scene(uv') > viewZ_surface` (объект ближе поверхности) ⇒ `uv' = uv`.

**Поглощение/рассеяние**: `T = exp(−σ_a L)`, `S = C_s · (1 − exp(−σ_s L)) · E_sun`;
`C = scene(uv')·(1 + caustic)·T + S + F·sky + spec_sun + foam`.

**Френель**: `F = 0.02 + 0.98·(1 − cosθ)^5`.

**Пена** (Sea of Thieves/Tidewater): `src = max(step(J, bias)·crest, shore(h), contact(h))`,
`foam_t = max(src, foam_{t−1}·e^{−dt/τ})` с размытием; τ ≈ 2–4 с.

## 3. Архитектура в нашем пайплайне

```
scene pass (MRT: HDR | albedo | normal | velocity | depth)     ← вода НЕ рисуется (слой Overlay выключен у камеры)
   → composite: direct + indirect×albedo  ─┐
                                           ├─ rtt(beauty) = sceneColor
overlay pass: та же сцена, камера-копия только со слоем Overlay ─┘  ← вода читает sceneColor + depth
   → final = mix(sceneColor, overlay.rgb, overlay.a) → FXAA
```

- Вода живёт в основной сцене (солнце, тени — те же), на слое `Layer.Overlay`; GI G-buffer
  рендерит слой 0 ⇒ воды не видит; трассировщик — `userData.giExclude`.
- Материал воды: `MeshStandardNodeMaterial`, opaque, `colorNode = 0` (весь диффуз — это
  сцена под водой), блик солнца и тень — из стандартной модели, всё остальное — в
  `emissiveNode`. Ручной depth-test против depth сцены (`Discard`), потому что проход
  воды имеет собственный depth.
- Экранные текстуры (`sceneColor`, `sceneDepth`) отдаёт `FrameGraph` через
  `onScreenTextures`; хост сцены пробрасывает их в воду (`bindScreen`).
- Этапы: **1** (этот коммит) — проход, рефракция, глубина, поглощение, каустика, пена по
  глубине + Якобиан, Герстнер с shoaling. **2** — персистентное поле пены (feedback RT).
  **3** — SSR, искры, спрей.

## 4. Симуляция (этап 2, реализовано): уравнения мелкой воды

Учебник: Сен-Венан (depth-averaged Navier–Stokes при λ ≫ глубина); дискретизация —
«виртуальные трубы» (Mei, Decaudin, Hu 2007), семейство Kass & Miller 1990.
Файл: `src/entities/water/shallowWater.ts`.

```
ячейка: столб воды d над дном b (текстура высот острова с камнями), H = b + d
трубы к 4 соседям, поток f_i (м³/с):  f_i ← max(0, f_i + Δt · A · g · (H − H_i) / l),  A = d̄·l  ⇒  c² = g·d
ограничение: Σ f_i · Δt ≤ d · l²  (нельзя слить больше, чем есть)
масса:  d ← d + Δt · (Σ входящих − Σ исходящих) / l²
скорость: u = (f_R(лев) − f_L + f_R − f_L(прав)) / (2 · l · d̄)
трение: f ← f · (1 − Δt·k), k = 0.12;  сглаживание потоков 8 % (гасит odd-even моду)
генератор: на открытых гранях (−x, +z) столб релаксирует к level + A·sin(ωt − k·s), A = 4 см, T = 1.2 с
устойчивость: Δt ≤ 0.4 · l / √(g·d_max);  512² (2.3 см) ⇒ Δt ≈ 2.6 мс, до 8 подшагов/кадр
пена-источник: быстрый поток на мелководье, сильная конвергенция  → персистентное поле пены (advect по u,v; e^{−Δt/2.8 с})
рендер: η = b + d (вершины), нормаль = ∇η на шаге сетки, плёнка < 2 см = мокрый песок (discard), η ≤ level + 0.12
```

Что даёт физика, чего не давал Герстнер: рефракция волн вокруг камней, shoaling
у пляжа, накат/откат (мокро/сухо), отражения от стен, пена там, где поток
действительно быстрый.

Инструменты: `?waterInspect=1|z:<м>` — карта поверхности сверху + разрезы (×2 с дном,
×25 поверхность) + статистика readback; `?cam=shore|rocks|water`; `scripts/_watersim.mjs`.

Открыто (этап 3): SSR, дисперсия коротких волн (SWE — недисперсионные: ветровая рябь
остаётся шумом нормалей), мокрый песок от симуляции (текстура «намокания»), спрей,
оптимизация (compute вместо quad-проходов, 256² для дальней воды).

## 5. Ветровые волны (этап 2b, реализовано): спектр + дисперсия

Уравнения мелкой воды недисперсионны и не несут ветровую рябь 5–50 см, а именно она
даёт «текстуру» лагуны и рефракцию дна. Учебник (океанография, линейная теория Эйри):

```
дисперсия конечной глубины:  ω² = g·k·tanh(k·h)   → частота сохраняется, k растёт на мелководье (shoaling, рефракция)
спектр JONSWAP (Hasselmann 1973): S(ω) = α g² ω⁻⁵ exp(−1.25 (ωp/ω)⁴) γ^r,  γ = 3.3
  ограниченный разгон: x̃ = g·F/U²,  ωp = 22 (g/U) x̃^−0.33,  α = 0.076 x̃^−0.22
поправка конечной глубины TMA (Bouws 1985): φ(ωh) = ½ωh² (ωh ≤ 1), 1 − ½(2 − ωh)² (1 < ωh < 2), 1
угловое распределение: D(θ) ∝ cos²(θ − θветра)
амплитуда компоненты: a = √(2 S(ω) φ D Δω Δθ);  усиление Грина ~ h^−1/4
```

Файл `src/entities/water/windWaves.ts`: 48 компонент (ω лог-равномерно 0.6..6 ωp, θ по cos²),
`uniformArray`; в шейдере на точку: k(h) из дисперсии, η += a·sin(k·x − ωt + φ),
наклон аналитически — нормаль без конечных разностей. Ветер 4.5 м/с, разгон 800 м.
Поверх симуляции мелкой воды (высоты и наклоны складываются). Рефракция экрана 0.12.
