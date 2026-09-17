export type Entry = {
  title: string;
  art: string;
  preview?: string;
  description: string;
  href: string;
  open: string;
  chips: { label: string; href: string }[];
};

const cams = (scene: string, names: string[]) =>
  names.map((name) => ({ label: name, href: `/?scene=${scene}&cam=${name}` }));

export const SCENES: Entry[] = [
  {
    title: 'Пляж',
    art: 'home-art-beach',
    description:
      'Песчаный слой из фотографий, пальмы с биологической оптикой листа, вода с преломлением, объёмный туман и блики. Главная площадка качества.',
    href: '/?scene=beach',
    open: 'Открыть',
    chips: cams('beach', ['shore', 'rocks', 'water', 'surf', 'eye', 'leaves', 'trunkLit', 'shrub', 'sunward', 'van']),
  },
  {
    title: 'Лес',
    art: 'home-art-forest',
    description:
      'Поляна на адаптивном рельефе: хвойные из ez-tree, ручей, скальные срезы, подрост. Проверка растительности и теней в массе.',
    href: '/?scene=forest',
    open: 'Открыть',
    chips: cams('forest', ['hero', 'wide', 'trail', 'stream', 'ledge', 'canopy', 'rim']),
  },
  {
    title: 'Коридор',
    art: 'home-art-corridor',
    description:
      'Замкнутый интерьер: слои зондов внутри и снаружи, протечки света через стены, контактное затенение у пола и скамьи.',
    href: '/?scene=corridor',
    open: 'Открыть',
    chips: [
      { label: 'bake-leak', href: '/?scene=corridor&cam=floor&leak=1&split=leak&hud=1' },
      { label: 'грубее: 0.1 м/тексель', href: '/?scene=corridor&cam=bench&lmDensity=0.1' },
      { label: 'тоньше: 0.03 м/тексель', href: '/?scene=corridor&cam=bench&lmDensity=0.03' },
      ...cams('corridor', ['hero', 'wide', 'bench', 'panels', 'floor', 'deep']),
    ],
  },
  {
    title: 'Коридор · динамический свет',
    art: 'home-art-corridor',
    description: 'Копия коридора с тремя движущимися цветными лампами и тенями. Пауза, скорость, мощность и отдельное отключение каждого источника в панели «Свет · коридор».',
    href: '/?scene=corridor-lights',
    open: 'Открыть лабу',
    chips: [
      ...cams('corridor-lights', ['hero', 'bench', 'deep']),
      { label: 'пауза', href: '/?scene=corridor-lights&lightMotion=0' },
    ],
  },
  {
    title: 'Деревня Мидси',
    art: 'home-art-village',
    preview: '/previews/midsee-village.png',
    description: 'В работе: средиземноморская деревня по концепту. Дома на террасах, колокольня, бухта и кафе на набережной. Превью обновляется по мере сборки.',
    href: '/?scene=midsee-village',
    open: 'Смотреть текущую сцену',
    chips: [
      { label: 'ALEXA 35 · 32mm', href: '/?scene=midsee-village&cam=front&cine=alexa35-32' },
      { label: 'анаморфот 2x', href: '/?scene=midsee-village&cam=front&cine=anamorphic-2x-40' },
      { label: 'IMAX 65', href: '/?scene=midsee-village&cam=front&cine=imax65-50' },
      ...cams('midsee-village', ['front', 'side', 'rear', 'quay', 'roofs']),
      { label: 'лёгкий стенд (1 дом)', href: '/?scene=village-light' },
      { label: 'лёгкий стенд · LOD-лаба', href: '/?scene=village-light&lodLab=1' },
      { label: 'LOD-лаба', href: '/?scene=midsee-village&cam=front&lodLab=1' },
      { label: 'грубее: 0.1 м/тексель', href: '/?scene=midsee-village&cam=front&lmDensity=0.1' },
      { label: 'тоньше: 0.03 м/тексель', href: '/?scene=midsee-village&cam=front&lmDensity=0.03' },
    ],
  },
  {
    title: 'Небо',
    art: 'home-art-beach',
    description:
      'Физическая атмосфера: LUT пропускания, многократного рассеяния и вида неба, диск солнца с потемнением к краю. То же небо освещает сцену: запекание, пробы, отражения и цвет солнца.',
    href: '/?scene=sky&cam=objects',
    open: 'Открыть лабу',
    chips: [
      { label: 'полдень', href: '/?scene=sky&cam=objects&sunAz=-60&sunEl=45&bakeCache=0' },
      { label: 'золотой час', href: '/?scene=sky&cam=objects&sunAz=-60&sunEl=10&bakeCache=0' },
      { label: 'закат', href: '/?scene=sky&cam=sunward&sunAz=-40&sunEl=2&bakeCache=0' },
      { label: 'сумерки', href: '/?scene=sky&cam=sunward&sunAz=-40&sunEl=-4&bakeCache=0' },
      { label: 'зенит', href: '/?scene=sky&cam=zenith&sunAz=-60&sunEl=30&bakeCache=0' },
      { label: 'с высоты 12 км', href: '/?scene=sky&cam=horizon&sunAz=-90&sunEl=8&skyAltitude=12&bakeCache=0' },
      { label: 'без неба (панорама)', href: '/?scene=sky&cam=objects&sky=0' },
    ],
  },
  {
    title: 'Масштабы · LOD лайтмапы',
    art: 'home-art-cornell',
    description:
      'Стенд для LOD лайтмапы: земля 24 м под перголой, один домик в четырёх масштабах, стена 18 м, и везде мелкие тени от реек — грубый уровень, шов тайла и скачок уровня видны сразу.',
    href: '/?scene=lod-scale&cam=overview',
    open: 'Открыть',
    chips: [
      ...cams('lod-scale', ['overview', 'eye', 'grazing', 'glow', 'pergola', 'ladder', 'wall', 'far']),
      { label: 'LOD-лаба', href: '/?scene=lod-scale&cam=eye&lodLab=1' },
      { label: 'пул 16 тайлов', href: '/?scene=lod-scale&cam=eye&vtPool=4' },
    ],
  },
  {
    title: 'Комната протечек',
    art: 'home-art-cornell',
    description:
      'Запаянная коробка на грунте: истинная освещённость внутри — ноль, любой свет там измеряет протечку. ?gap= открывает щель в миллиметрах, и настоящий свет обязан вернуться.',
    href: '/?scene=leak-room&cam=contact',
    open: 'Открыть',
    chips: [
      { label: 'bake-leak', href: '/?scene=leak-room&cam=contact&leak=1&split=leak&hud=1' },
      ...cams('leak-room', ['contact', 'inside', 'floor', 'outside']),
      { label: 'gap=1mm', href: '/?scene=leak-room&cam=contact&gap=1' },
      { label: 'gap=20mm', href: '/?scene=leak-room&cam=contact&gap=20' },
    ],
  },
  {
    title: 'Cornell box',
    art: 'home-art-cornell',
    description:
      'Эталон непрямого света: цветные стены, подвижные тела. Сцена по умолчанию — любой адрес, где ?scene= не назван.',
    href: '/?hud=1',
    open: 'Открыть',
    chips: [
      { label: 'split=baked', href: '/?hud=1&split=baked' },
      { label: 'lmDensity=0.1', href: '/?hud=1&lmDensity=0.1' },
      { label: 'lmDensity=0.03', href: '/?hud=1&lmDensity=0.03' },
      { label: 'surfelGi=1', href: '/?hud=1&surfelGi=1' },
      { label: 'bakeCache=0', href: '/?hud=1&bakeCache=0' },
    ],
  },
];

export const LABS: Entry[] = [
  {
    title: 'Лаборатория R3F',
    art: 'home-art-fiber',
    description:
      'Форк @vibegameengine/react-three-fiber, подключённый исходниками: правка в vendor видна в следующем кадре. Проверка React 19 + WebGPU.',
    href: '/labs/fiber/',
    open: 'Открыть',
    chips: [],
  },
  {
    title: 'Лаборатория воды',
    art: 'home-art-water',
    description:
      'Спектр волн, батиметрия, отражение и преломление по отдельности. Мяч над водой, красный столб и подводный камень как оптические меры.',
    href: '/labs/water/',
    open: 'Открыть',
    chips: [
      { label: 'ocean', href: '/labs/water/?scene=ocean' },
      { label: 'pool', href: '/labs/water/?scene=pool' },
    ],
  },
];

export const DOCS: Entry[] = [
  {
    title: 'RDR2 как база',
    art: 'home-art-doc',
    description:
      'Разбор кадра большой игры и карта того, что из него перенесено сюда: порядок проходов, бюджеты, приёмы соседей.',
    href: '/pipeline',
    open: 'Читать',
    chips: [],
  },
  {
    title: 'Свет концепта на 120 fps',
    art: 'home-art-doc',
    description:
      'Почему кадр темнее концепта и что из расхождения — экспозиция, HDR, непрямой свет, а что материалы. Художественный Look-слой поверх игрового конвейера в бюджете 8,33 мс.',
    href: '/lighting-look-development.html',
    open: 'Читать',
    chips: [
      { label: 'настройки художника', href: '/lighting-look-development.html#controls' },
      { label: 'приёмка', href: '/lighting-look-development.html#acceptance' },
    ],
  },
];

export const FLAGS: { key: string; effect: string }[] = [
  { key: '?hud=0', effect: 'Убрать HUD и панель настроек из кадра.' },
  { key: '?still=1', effect: 'Заморозить анимацию сцены для сравнения кадров.' },
  { key: '?aa=taa|fxaa|none', effect: 'Сглаживание. По умолчанию TAA.' },
  { key: '?fog=0|1', effect: 'Объёмный туман froxel-сеткой.' },
  { key: '?reflections=0', effect: 'Отключить трассированные отражения.' },
  { key: '?contact=1', effect: 'Контактное затенение короткими лучами.' },
  { key: '?split=baked', effect: 'Показать отдельный слой освещения.' },
  { key: '?lodLab=1', effect: 'Лаба LOD: слева сцена, справа рабочий атлас 512², собранный из страниц бейка под текущий кадр, рамки цветом mip.' },
  { key: '?lod=0', effect: 'Абляция: материалы читают полный запечённый атлас напрямую, без страниц и стриминга.' },
  { key: '?lmDensity=', effect: 'Метры мира на тексель лайтмапа. 0.05 по умолчанию; атлас растёт страницами, чтобы удержать заданную плотность. 0 возвращает плотность, посчитанную от площади сцены.' },
  { key: '?sample=', effect: 'Шаг решётки замеров в метрах (0.1 по умолчанию): столько мира приходится на один сурфель бейка, остальное разносится по протрассированным связям. 0 ставит сурфель на каждый тексель.' },
  { key: '?pipeline=legacy', effect: 'Старый конвейер с живыми сурфелями.' },
  { key: '?look=0', effect: 'Отключить художественный слой целиком (папка Look в GUI).' },
  { key: '?cine=', effect: 'Пресет реальной киношной камеры: alexa35-32, alexa-lf-40, venice2-24, raptor-50, anamorphic-2x-40, imax65-50. Сенсор и фокусное задают кадр, угол обтюратора — смаз. Папка Cine camera в GUI.' },
  { key: '?exposureEV=', effect: 'Компенсация экспозиции поверх действующей E_camera(t), в стопах.' },
  { key: '?indirectEV=', effect: 'Усиление рассеянного непрямого света у получателей, в стопах. Бейк не трогает.' },
  { key: '?lookOutput=', effect: 'Output transform: neutral (по умолчанию), agx, linear для диагностики.' },
];
