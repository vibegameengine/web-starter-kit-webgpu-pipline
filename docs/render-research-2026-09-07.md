# ThreejsShowcase: исследование перед постановкой goal

> Уточнение пользователя: главный источник — jure/webgiya. Развиваем его surfel GI; path tracing не добавляем. Приоритет — виртуализация/стриминг текстур и lightmaps, качественное наложение, отдельная дешёвая модель динамики в едином со статикой мире. Локальные references — сырые примеры, не истина. Ниже сохранён исходный исследовательский срез; актуальное направление и правило полезных коротких итераций находятся в `render-quality-goal.md`.

Дата: 2026-09-07. Область исследования: текущий корневой checkout, его код, работающий браузерный рендер и перечисленные ниже первоисточники. Реализация рендера в этом исследовании не менялась. Другие checkout в `worktrees/` не использованы как доказательство интеграции.

## Что работает сейчас

- Vite, Three.js r182, WebGPURenderer, TSL/WGSL. Вход — `src/app/main.ts`, а не упоминаемый в старом документе `vendor/webgiya`.
- Контрольная сцена Cornell с цветными стенами, статическими коробками и движущимся шаром. Есть варианты сцены с emissive и локальными источниками.
- `src/shared/gi/surfelGI.ts`: lifecycle surfels, hash grid, GPU-интеграция, guided sampling, временное накопление MSME, статический bake/warmup и экранный resolve. Статическая и динамическая геометрия трассируются через отдельные BVH.
- `src/shared/gi/bake/`: реальный UV-space G-buffer, surfel на texel, интеграция света, фильтрация и заполнение границ карты. По умолчанию lightmap 512², 200 интеграций по 32 луча.
- `src/shared/render/frameGraph.ts`: MRT HDR/albedo/normal/velocity, композиция direct + indirect × albedo, FXAA и диагностический split. В renderer фактически Neutral tone mapping.
- Имеются hooks для фиксированной камеры и позы, чтения surfel-статистики и опциональных GPU timestamps; это полезная основа измерений, но не готовый benchmark.

## Главные разрывы относительно идеи пользователя

1. **Запекание и realtime пока переключаются.** `main.ts:297` убирает экранный GI при переходе на lightmap, `main.ts:581` выполняет GI update только для `surfel`. Следовательно, библиотечный флаг `dynsurfel` сам по себе не делает гибридную интеграцию в этом приложении.
2. **Динамический приёмник теряет GI в lightmap.** На свежем снимке шар имеет почти чёрную нижнюю половину. Это согласуется с выключенным GI update и отсутствием UV-lightmap у подвижного шара.
3. **UV-путь ограничен геометрией коробок.** `lightmapUv.ts:87` прямо задаёт этот контракт. InstancedMesh и неподходящие меши отклоняются. Для общего контента нужны полноценный unwrap и управление плотностью/страницами.
4. **Bake использует runtime-представление с его ограничениями.** Пул имеет потолок 262144 surfels на desktop; lightmap выделяет surfel на texel. Текущий bake не является независимым path-traced эталоном. Его многократные отражения оцениваются через surfel lookup, зависящий от фиксированного центра и пространственных приближений.
5. **Единое состояние света не завершено.** HUD сравнивает `world.sunVersion`, но в прочитанном `main.ts` и light controls нет соединения изменения углов с `world.setSunAngles`. Наличие счётчика не доказывает рабочую инвалидизацию.
6. **Итоговая цепочка ещё минимальна.** Velocity записывается, но финальный AA — FXAA. Комментарии о будущих отражениях, probes, каскадных тенях и атмосфере не являются наличием этих систем в активном frame graph.
7. **Документы частично устарели.** `CLAUDE.md` ещё описывает WebGL и лес. `docs/ue-pipeline-study-and-plan.md` объявляет `src` неактивным и запрещает UV-bake. Фактический код и актуальная просьба пользователя этому противоречат. Будущая реализация должна актуализировать документы, сохраняя binding scope пользователя.

## Свежая визуальная проверка

Оба режима открывались в headed system Chrome с WebGPU на NVIDIA Lovelace; системный GPU — NVIDIA GeForce RTX 4080 SUPER, драйвер 32.0.15.9571. Разрешение снимков 1600×900, DPR=1, одинаковая поза `freezeAt=0`.

- [Surfel](../shots/research-20260907-surfel.png): GI освещает шар и переносит цвет стен; на поверхностях заметны полосы/неоднородности, требующие исследования по буферам.
- [Lightmap](../shots/research-20260907-lightmap.png): освещение статики есть, распределение света отличается; нижняя часть шара почти чёрная. Причины всех различий статики пока не измерялись.
- Фатальных ошибок и видимого error overlay не было. Есть предупреждение Inspector о frame scope. Lightmap-запуск сообщил рост пула до 262144 элементов, оценка самого пула 187 MiB; это не суммарная VRAM приложения.
- 120 FPS на снимках — показание HUD, не результат профилирования. Производительность, временной шум, SSIM и ошибка относительно эталона в этом исследовании не измерялись.

Воспроизведение при работающем Vite на 5188:

```powershell
node scripts/capture-chrome.mjs shots/research-20260907-surfel.png --url 'http://127.0.0.1:5188/?hud=0&split=off&freezeAt=0' --wait 45000 --headed
node scripts/capture-chrome.mjs shots/research-20260907-lightmap.png --url 'http://127.0.0.1:5188/?mode=lightmap&hud=0&split=off&freezeAt=0' --wait 55000 --headed
```

## Исследования и их применимость

### Локальные references

Проверены все четыре элемента верхнего уровня `references`: три каталога и ZIP. Ниже перечислен прочитанный rendering-код; это не заявление о построчном аудите всей игры TheLongSilence. Его игровые подсистемы не требуются для выбора GI. Превью референсов просмотрены с диска; эти изображения поставляются с референсами и не являются свежими runtime-бенчмарками.

| Референс | Прочитано / проверено | Применение и границы |
|---|---|---|
| `TheLongSilence` | README, package.json, `core/Engine.js` (инициализация, resize, adapt и порядок render), `gfx/PostFX.js` (depth/AO, prefilter, luminance/adaptation, поиск composite/AgX), `gfx/cubeBake.js`, `world/Planet.js` (bake), ключевые разделы `ship/interiorMaterials.js`, загрузка `interiorAssets.js`, `tools/bake_interior.py`, `tools/boot.mjs`, `tools/levels.mjs`; просмотрен `public/og.jpg` | Полезны предфильтрованные albedo/normal/ORM, AO-kit, HDR, экспозиция и воспроизводимость снимков. Planet bake хранит материал/высоту, интерьерный bake — материалы/AO: это не готовый многократный GI-baker. Interior fill и часть отражений аналитически авторские |
| `spiri0-clouds` | README, `src/main.js`, `src/cloud-model.js`, `resources/shader/cloudsFS.js`; просмотрен `social.jpg` | Генерация 3D noise, weather/height density, raymarch, затухание и шаги к солнцу. В shader 128 основных шагов и 6 световых, early exit по transmittance. Копирование бюджета без профилирования не обосновано; depth-конвенции, освещение и temporal reconstruction требуют адаптации |
| `fluffygrass` | package.json, `src/App.jsx`, `Grass.jsx`, `WindLayer.js`, `BlobGeometry.jsx`, `Butterfly.jsx`; просмотрен `thumbnail.png` | 60000 инстансов травы, sampling по поверхности, пространственно меняющийся цвет, ветер с закреплённым основанием. Ветер здесь продвигается на 0.005 за кадр; в нашем runtime нужен dt и согласованные деформированные normals/shadows/velocity. React/Lamina/WebGL не переносятся как новый runtime проекта |
| `2c7ac93a-809e-4bbc-b39f-4b21bfa325b0.zip` | Прочитан каталог архива без распаковки; SHA-256 всех 11 файлов `src` и package.json совпал с `fluffygrass` | Архив содержит тот же исходный пример травы; дополнительный рендерер внутри не найден |

Конкретные выводы из исходников:

- **Материалы нужно предфильтровать.** Мелкие процедурные линии и рельеф могут мерцать даже с MSAA. TheLongSilence переносит детали в mipmapped baked textures; наши контрольные проходы должны проверять материал на скользящих углах, а не только границы геометрии.
- **Данные разных смыслов разделяются.** Cubemap материала, AO и lightmap irradiance решают разные задачи. Базовый цвет с уже вшитым затенением нельзя незаметно считать физическим albedo в эталонном GI.
- **Проверять реализацию, а не термин в README.** Текущий `PostFX` TheLongSilence накапливает квадрат яркости и извлекает корень (RMS; на земле есть дополнительное экранное взвешивание), затем адаптируется в log2-пространстве. Это содержательно точнее формулировки README «sqrt mean». Для нашего интерьера/экстерьера выбор метрики экспозиции нужно измерить заново.
- **Bloom согласуется с экспозицией.** В прочитанном prefilter порог применяется в экспонированных единицах, затем вклад возвращается в scene-linear. Это полезный договор между проходами, а не повод копировать художественные пороги.
- **Реконструкция имеет геометрический смысл.** TheLongSilence отдельно нормализует варианты depth и учитывает позицию центра texel при AO; в WebGPU следует согласовать собственные depth, motion и normal conventions. Их численные результаты из комментариев здесь не воспроизводились.
- **Референсы содержат приближения.** `spiri0-clouds` задаёт ambient и солнце упрощённо, только проверяет начало облачного интервала относительно scene depth, а не обрезает весь интервал по препятствию. TheLongSilence добавляет directional fill по нормали/высоте/прямому свету. Эти решения нельзя объявлять физически корректной заменой многократного переноса света.
- **Версии различаются.** TheLongSilence использует Three ^0.185.1 и WebGL2, fluffygrass — Three 0.170.0 и React/Lamina, наш проект — Three ^0.182.0/WebGPU. Прямое подключение shader hooks не является корректным портированием.

### Внешние первоисточники

| Первоисточник | Что он даёт | Вывод для этого проекта |
|---|---|---|
| [EA GIBS, SIGGRAPH 2021](https://advances.realtimerendering.com/s2021/index.html) | Surfel-кеширование diffuse GI, распределение работы между кадрами, направленная выборка | Развивать уже имеющуюся основу; название метода не гарантирует качество конкретного resolve |
| [Lumen Technical Details, Epic](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-technical-details-in-unreal-engine) | Surface Cache, screen/world tracing, ограничения и диагностические режимы | Lumen GI не комбинируется со static lightmaps; Lumen Reflections могут. Наша идея требует собственного согласованного гибрида |
| [Brixelizer GI, AMD](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/brixelizer-gi/) | Экранные probes, world irradiance cache, diffuse/specular, reprojection | Полезный образец многоуровневого кеша. SDF получает radiance из предыдущих кадров; заменить наш triangle BVH на SDF — отдельное решение с потерями детализации |
| [DDGI для production, Majercik et al., 2021](https://jcgt.org/published/0010/02/01/) | Масштабирование probe-based динамического освещения | Кандидат для освещения движущихся приёмников; плотность и проверка видимости должны быть проверены на тонких стенах. В этом проходе просмотрена карточка работы, полный текст ещё нужно изучить |
| [UberBake, Seyb et al., SIGGRAPH 2020](https://cs.dartmouth.edu/~wjarosz/publications/seyb20uberbake.html) | Запечённые изменения вкладов ламп и состояний дверей | Подходит для ограниченных заранее известных состояний; не решает произвольную динамику одной интерполяцией |
| [Hybrid Rendering for Dynamic Scenes, 2024](https://arxiv.org/html/2406.07906v1) | Предвычисленная статическая база и вычисление разницы с текущей сценой | Самый близкий научный предшественник идеи bake + signed correction. Работа использует neural representation; перенос принципа в наш lightmap/surfel runtime является гипотезой |
| [ReSTIR PT Enhanced, Lin et al., 2026](https://research.nvidia.com/labs/rtr/publication/lin2026restirptenhanced/) | Улучшения повторного использования путей, корреляции и стоимости; авторы сообщают ускорение 2–3× относительно своей базы | Кандидат для дорогих световых путей, а не обещание 2–3× в нашем браузере. Отрицательная residual-коррекция не является допустимым весом обычного reservoir без отдельной формулировки |

## Рекомендуемый принцип и открытые вопросы

Это проектное предложение, а не уже реализованный или доказанно новый алгоритм:

`indirect_static_receiver(t) = baked_indirect + estimated_indirect_change(t)`

Direct, emission и specular имеют отдельные явно определённые вклады. Простое сложение полной lightmap и полного realtime GI повторно учитывает статический свет. Простое плавное смешивание карт не восстановит перекрытие света новым объектом. Нужны отрицательные изменения, согласованные единицы и validity модели.

Исследовательская гипотеза: парная оценка текущего и базового переноса с общей случайной выборкой может дать меньшую дисперсию residual. Проверить диапазон применимости, стоимость двух оценок, несовпадение приближённой базы с bake, обработку новых поверхностей, сильной смены света и быстрых occluders. При недостаточной корреляции преимущество может исчезнуть. Коэффициент доверия не исправляет смещение автоматически: политика fallback и её ошибка тоже измеряются.

Высокочастотная статическая детализация живёт в направленных картах, пространственное поле освещает movers, динамический кеш оценивает изменения, локальная трассировка уточняет видимость и specular. Выбор точных представлений должен следовать A/B и профилированию, а не заранее навязанному списку технологий.

Рекомендуемый следующий результат — реализация по [готовому goal](render-quality-goal.md). Численные пороги в нём являются предлагаемыми целями будущей работы, не результатами этого исследования. Превосходство над UE5 и научная новизна пока не проверены.

## Реализованная адаптация: LOD запечённого света в GI (итерация 09)

Первоисточник идеи проекции ray cone: [Improved Shader and Texture Level of Detail Using Ray Cones, Akenine-Möller et al., JCGT 2021](https://research.nvidia.com/publication/2021-04_improved-shader-and-texture-level-detail-using-ray-cones). Просмотрена официальная карточка с описанием и errata; исходный код не переносился. Локальный `bakedHitLod.ts` написан для существующего Webgiya-интегратора и общего virtual lightmap sampler.

Известный принцип: оценивать текстурный footprint луча без экранных производных. Локальная реализация строит градиенты atlas UV по мировым вершинам треугольника, проецирует их вдоль направления луча и берёт максимальную сингулярную величину для консервативной изотропной выборки. Проверены GPU-результаты с аналитическими значениями для масштаба мира/UV, поворота chart, скользящего угла, дробного mip и вырожденного треугольника.

Отдельная проектная гипотеза — распространение конуса: размер определяется пикселем выходного framebuffer, проекцией камеры и длиной camera→receiver→hit, без расширения на кривизне/BRDF. Это приближение управления детализацией, не полная модель diffuse footprint и не доказательство физической точности. Радиус поиска соседних surfels не используется как радиус размытия lightmap. Анизотропный фильтр и chart-aware mip остаются открыты. Чужие показатели ускорения не относятся к этой реализации; новый путь проверяется по реальным запросам страниц и сохранению света, без заявления об ускорении кадра.

## Изоляция UV charts при фильтрации (итерация 10)

[Microsoft: Using UVAtlas](https://learn.microsoft.com/en-us/windows/win32/direct3d9/using-uvatlas) описывает назначение gutter между charts для bilinear/mip filtering. Переноса UVAtlas/D3D9 кода нет. В текущем проекте выбран собственный способ согласовать существующий shelf packer с ограниченной цепочкой virtual mip: выравнивание прямоугольников на блоки coarsest mip, защитный UV inset и заполнение всех пустых texels внутри отдельного chart только из его измеренных образцов.

При границах, кратных `2^M`, каждый блок downsample до mip M целиком принадлежит одному прямоугольнику. При UV inset не менее `2^M/2` даже крайний bilinear footprint до mip M остаётся внутри этого прямоугольника. Поэтому прежний box mip generator одинаково работает в браузере и Node packer, не получая таблиц charts во время исполнения. Это свойство конечной поддержанной mip-цепочки, не гарантия для неограниченного уровня уменьшения или анизотропии. Математический принцип проверен production GPU sampler на соседних RGB/black charts и fractional LOD; ошибочная раскладка оставлена только как контроль в тесте.

Brightness-based заполнение было удалено из активного пути: тёмный измеренный texel не является признаком отсутствия данных. Финальный atlas теперь сохраняет coverage в alpha; расширяются только отсутствующие образцы, в пределах chart. Геометрически неверная bake-позиция внутри другого тела требует отдельной геометрической диагностики; заимствование яркости у соседнего chart не является её исправлением.

## Ограниченная анизотропия virtual lightmap (итерация 15)

[PBRT 4: Image Texture](https://pbr-book.org/4ed/Textures_and_Materials/Image_Texture) объясняет потерю деталей при изотропном описании вытянутого footprint и выбор уровня по малой оси с ограничением анизотропии в EWA. Использован принцип текстурной фильтрации; код PBRT и path tracer не переносились.

Локальный raster sampler получает сингулярные оси экранного UV Jacobian и выполняет до восьми линейных выборок существующего virtual sampler. Это более простое приближение, чем EWA, с явным пределом работы. Дополнительное проектное условие — ограничивать каждый tap границами своего lightmap chart; общие fallback/page fade сохраняются. GPU проверка контрольных частот показывает сохранение деталей поперёк footprint и усреднение вдоль него. Она не устанавливает превосходство над EWA, полной аппаратной анизотропией или чужими рендерами. Compute GI пока использует прежний изотропный конус; ограничения и фактические результаты записаны в итерации 15.

## Распределение работы динамического GI (итерация 16)

[EA SEED: GIBS, SIGGRAPH 2021](https://www.ea.com/seed/news/siggraph21-global-illumination-surfels) описывает пространственное и временное переиспользование расчётов через surfels. Это общий принцип, а не источник конкретных порогов или очереди этого проекта. Существующий webgiya integrator уже адаптировал число лучей по MSME; локальная надстройка вводит общий бюджет поверх этих запросов, не заменяя интегратор. Чужой код планировщика не переносился.

Приоритет свежести/движения/inconsistency, повышение приоритета с ожиданием и cadence=4 для стабильной истории — проектные эвристики. Контроль GPU подтверждает ограничение первичных samples и сохранение отложенной истории, но не даёт гарантии FPS или качества света при произвольно малом бюджете. Периодическое обновление остаётся обязательным: положение самого приёмника не обнаруживает изменений всех источников и перекрывающих объектов.

## Самозатенение при PCF (итерация 19)

[Microsoft: Cascaded Shadow Maps — Calculating a Per-Texel Depth Bias with DDX and DDY](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps#calculating-a-per-texel-depth-bias-with-ddx-and-ddy-for-large-pcfs) описывает восстановление изменения глубины в координатах shadow map из экранных производных. Соседние texels плоского приёмника требуют разных глубин сравнения. Это существующий метод; новизна не заявляется.

Локальный receiverPlaneShadow.ts применяет его к обычной направленной карте теней текущего Three r182 WebGPU. Реализация написана на TSL, node_modules не изменён. Шестнадцать прямых depth loads дают отдельное сравнение на центре каждого texel; separable weights образуют непрерывно сдвигаемый фильтр 3x3. Встроенный PCFSoftShadowFilter также имеет 16 texture operations, но аппаратное сравнение использует одну глубину для нескольких texels. Геометрия, normalBias, constant bias и карта 4096 не увеличены. Дополнительная арифметика производных не означает доказанного нулевого изменения GPU-времени. Метод предполагает локально плоский receiver; разрывы производных и вырожденная проекция остаются ограничениями. Point lights, cube maps и CSM arrays в эту интеграцию не входят.

## 2026-09-08 — «воздух» как перенос света: источники по мягким теням и рассеянию

Запрос пользователя: объекты в кадре должны «примешиваться» друг к другу, как в жизни и у Pixar, без жёстких переходов. Это не участвующая среда, а перенос света: полутени по угловому размеру солнца, отскок и перенос цвета, контактная окклюзия, рассеяние в объективе. Собранные источники:

- Fernando 2005, *Percentage-Closer Soft Shadows* — https://developer.download.nvidia.com/shaderlibrary/docs/shadow_PCSS.pdf. Поиск блокеров, средняя глубина, ширина полутени по подобным треугольникам; для directional света ширина = d_blocker·tan α, где α — угловой диаметр источника.
- NVIDIA GameWorks *Soft Shadows Sample* — https://archive.docs.nvidia.com/gameworks/content/gameworkslibrary/graphicssamples/opengl_samples/softshadowssample.htm. Градиентный (receiver-plane) bias, масштабируемый расстоянием по uv от центра ядра; дополнительный bias при записи глубины.
- Bavoil, GDC 2008, *Advanced Soft Shadow Mapping Techniques* — https://developer.download.nvidia.com/presentations/2008/GDC/GDC08_SoftShadowMapping.pdf.
- Bevy PR #13497 (pcwalton, 2024) — https://github.com/bevyengine/bevy/pull/13497. PCSS для directional/point/spot; без temporal-накопления результат шумный, лучше — mip-цепочка shadow map; шум IGN считается приемлемее белого.
- vsg-dev discussion #1107 — https://github.com/vsg-dev/VulkanSceneGraph/discussions/1107. Depth clamping shadow-камеры сплющивает блокеры на near plane и портит оценку полутени; порядок выборок диска по y ради кэша даёт до ~2× по FPS при больших радиусах.
- Epic forum, *Receiver plane depth bias for directional shadow* — https://forums.unrealengine.com/t/receiver-plane-depth-bias-for-directional-shadow/96764.
- UE5 docs: *Virtual Shadow Maps* (SMRT — лучи к источнику по source angle, contact hardening), *Contact Shadows*, *Distance Field Soft Shadows* — https://dev.epicgames.com/documentation/unreal-engine/virtual-shadow-maps-in-unreal-engine, https://dev.epicgames.com/documentation/unreal-engine/contact-shadows-in-unreal-engine, https://dev.epicgames.com/documentation/en-us/unreal-engine/distance-field-soft-shadows-in-unreal-engine. Directional Light «Source Angle» задаёт полутень.
- Remedy, *How Northlight makes Alan Wake 2 shine* — https://www.remedygames.com/article/how-northlight-makes-alan-wake-2-shine (GPU-driven pipeline; настройки теней включают PCF/PCSS).
- Pixar RenderMan docs: Global Illumination / Lighting — https://renderman.pixar.com/resources/RenderMan_20/globalIllumination.html, https://rmanwiki-26.pixar.com/space/REN26/19661727/Lighting. Мягкие тени от площадных источников, color bleeding, AO как приближение мягких контактных теней.
- Ранее собранные: Hillaire 2020 (sky/aerial LUT), Wronski 2014 (froxel fog) — применены в итерации 21 для тумана; туман признан не тем эффектом.

Что взято в `softSunShadow.ts`: PCSS с α = 0.533°, поиск блокеров в конусе d_receiver·tan(α/2), ортографическая линейная глубина → d = Δz·(far − near), 16/32 Poisson с blue-noise поворотом и сортировкой по y, receiver-plane bias на каждую выборку с ограничением по склону 70°/тексель, жёсткое ядро (<1.5 тексель) — прежний точный фильтр 4×4.

### Временное накопление (TAA), 2026-09-08

- Karis, *High Quality Temporal Supersampling* (SIGGRAPH 2014, UE4) — https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf. Джиттер Halton, дилатация velocity по ближайшей глубине 3×3, взвешивание 1/(1+luma) против мерцания, YCoCg-бокс соседей.
- Salvi, *An excursion in temporal supersampling* (GDC 2016) — variance clipping: клип истории в mean ± γ·σ вместо min/max-бокса.
- Jimenez, *Filmic SMAA / TAA in Call of Duty: Advanced Warfare* (SIGGRAPH 2016) — Catmull-Rom (9/5 выборок) для истории вместо билинейной, чтобы не размывать.
- Pedersen, *Temporal Reprojection Anti-Aliasing in INSIDE* (GDC 2016) — https://github.com/playdeadgames/temporal. Клип AABB вдоль отрезка, а не clamp; отбраковка по скорости.
- three.js r182 `examples/jsm/tsl/display/TRAANode.js` — прочитан построчно как образец обвязки для WebGPU/TSL: RendererUtils.resetRendererState вокруг quad-рендера, copyTextureToTexture в history, passTexture как выход, setViewOffset для джиттера, `velocity.setProjectionMatrix(unjittered)` чтобы motion vectors не несли джиттер, depth-история для disocclusion. Лицензия MIT.

Реализовано в `src/shared/render/temporalAA.ts` (итерация 23). Джиттер применяется в начале кадра (`FrameGraph.beginFrame`), а не внутри post-processing, потому что G-buffer surfel GI и туман должны рендериться той же проекцией.

### Контактная окклюзия и bent normals, 2026-09-08

- UE deferred: GBuffer хранит `IndirectIrradiance` (lightmap) отдельно от прямого света, и AO (`GBufferAO`, SSAO) умножает только непрямые члены — DiffuseIndirectLighting, IndirectIrradiance. Прямой свет затеняется shadow map, AO его не трогает. — https://interplayoflight.wordpress.com/2017/10/25/how-unreal-renders-a-frame-part-2/, https://medium.com/@lordned/unreal-engine-4-rendering-part-4-the-deferred-shading-pipeline-389fc0175789, https://dev.epicgames.com/documentation/unreal-engine/ambient-occlusion?application_version=4.27.
- Lumen short-range AO: полноразрешающая окклюзия малого радиуса добавляет высокочастотный контакт, которого нет у даунсэмпленных screen probes; вариант с bent normal улучшает спекуляр-окклюзию (`r.Lumen.ScreenProbeGather.ShortRangeAO.BentNormal`) — https://unrealdirective.com/resources/console-variables/r-lumen-screenprobegather-shortrangeao-bentnormal/.
- Klehm, Ritschel, Eisemann, Seidel, *Bent Normals and Cones in Screen-space* (VMV 2011) — https://graphics.tudelft.nl/Publications-new/2012/KRES12/paper.pdf. Bent normal = средняя незанятая направление, конус видимости = (bent normal, AO); спекуляр-окклюзия как пересечение лепестка отражения с конусом.
- RTAO: 1 луч/пиксель в косинус-взвешенной полусфере + пространственно-временной денойз (Microsoft D3D12 RealTimeDenoisedAmbientOcclusion) — https://github.com/microsoft/DirectX-Graphics-Samples/tree/master/Samples/Desktop/D3D12Raytracing/src/D3D12RaytracingRealTimeDenoisedAmbientOcclusion; ограничения RTAO как обесцвечивателя света — https://www.gamedeveloper.com/programming/the-dark-side-of-ray-traced-ambient-occlusion-rtao-.
- Наше отличие: статический и динамический BVH с ray query уже есть в compute (`traceSceneOccluded`), поэтому контактная окклюзия может быть настоящей трассировкой коротких лучей, а не экранной; накопление — через TAA (итерация 23).

### Отражения, 2026-09-08

- Stachowiak, *Stochastic Screen-Space Reflections* (SIGGRAPH 2015, Frostbite) — https://www.ea.com/frostbite/news/stochastic-screen-space-reflections, конспект автора https://h3.gd/stochastic-ssr/. Importance-sampling GGX, трассировка на половине разрешения, переиспользование лучей соседей, пространственно-временной фильтр.
- Grenier, *Reprojecting Reflections* — https://www.jpgrenier.org/reflections.html. Перепроецирование отражения по виртуальной глубине отражённой точки, а не по глубине отражателя.
- Epic, *Lumen Technical Details* — https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-technical-details-in-unreal-engine и *Lumen Performance Guide*. Порядок: screen trace → software/hardware ray trace → skylight; порог roughness 0.4 (`Max Roughness To Trace`), выше — дешёвое приближение из GI.
- three r182 `DFGLUT` (split-sum DFG таблица 16×16, экспорт `three/tsl`) и `EnvironmentBRDF`: specularColor·A + F90·B; спекуляр-окклюзия в `PhysicalLightingModel.ambientOcclusion` по Lagarde.

Реализовано в `src/shared/gi/reflect/reflectionPass.ts` (итерация 25): GGX-луч на ячейку, экранный трейс по глубине G-buffer GI и цвету TAA-истории, при промахе — closest-hit по контактному дереву и движимым с шейдингом `giShadeHit` (тот же список источников и теневые лучи, что у GI), при промахе — окружение; история с проверкой глубины; в composite — DFG LUT и bent-cone окклюзия контакта.

## Motion blur / depth of field (собрано 2026-09-08, для следующего прохода)

- McGuire, Hennessy, Bukowski, Osman, «A Reconstruction Filter for Plausible Motion Blur», I3D 2012 — TileMax/NeighborMax по буферу скоростей, реконструкция с весами по глубине и скорости: https://casual-effects.com/research/McGuire2012Blur/McGuire12Blur.pdf (страница: https://casual-effects.com/research/McGuire2012Blur/index.html). Разбор реализации: https://aminaliari.github.io/posts/motionblur/, код https://github.com/AminAliari/motion-blur. NVIDIA GameWorks sample: https://archive.docs.nvidia.com/gameworks/content/gameworkslibrary/graphicssamples/opengl_samples/motionblurgl4gles3advancedsample.htm
- Jimenez, «Next Generation Post Processing in Call of Duty: Advanced Warfare», SIGGRAPH 2014 — scatter-as-gather для DoF и motion blur с явной прозрачностью, bloom-пирамида, отделимый SSS: https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/ (сборник: https://advances.realtimerendering.com/s2014/). Конспект: https://scrapbox.io/0b5vr/Next_Generation_Post_Processing_in_Call_of_Duty:_Advanced_Warfare
- UE5: `MotionBlurVelocityFlatten.usf` (`PreprocessVelocityForMotionBlur`, `CAMERA_MOTION_BLUR_MODE`), `PostProcessMotionBlur.usf` (half-res setup, MRT velocity+mask / colour+depth): https://github.com/raysjoshua/UnrealEngine/blob/master/Engine/Shaders/PostProcessMotionBlur.usf ; документация https://dev.epicgames.com/documentation/en-us/unreal-engine/setting-up-motion-blur
- DoF: AMD FidelityFX Depth of Field (scatter-as-gather для ближнего поля, max-CoC поиск): https://gpuopen.com/manuals/fidelityfx_sdk/techniques/depth-of-field/ ; GPU Gems 3 гл. 28 «Practical Post-Process Depth of Field»: https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-28-practical-post-process-depth-field ; Pixar «Interactive Depth of Field Using Simulated Diffusion on a GPU»: https://graphics.pixar.com/library/DepthOfField/paper.pdf ; однопроходный bokeh (Voxagon): https://blog.voxagon.se/2018/05/04/bokeh-depth-of-field-in-single-pass.html ; сравнение алгоритмов bokeh: https://github.com/Erfan-Ahmadi/BokehDepthOfField ; полигональные апертуры: https://www.researchgate.net/publication/261860589_Efficiently_Simulating_the_Bokeh_of_Polygonal_Apertures_in_a_Post-Process_Depth_of_Field_Shader
