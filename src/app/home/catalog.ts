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

const withLodLab = (scene: string, names: string[]) =>
  [{ label: 'lod-lab', href: `/?scene=${scene}&cam=${names[0]}&lod=1&lodLab=1` }, ...cams(scene, names)];

export const SCENES: Entry[] = [
  {
    title: 'Пляж',
    art: 'home-art-beach',
    description:
      'Песчаный слой из фотографий, пальмы с биологической оптикой листа, вода с преломлением, объёмный туман и блики. Главная площадка качества.',
    href: '/?scene=beach',
    open: 'Открыть',
    chips: withLodLab('beach', ['shore', 'rocks', 'water', 'surf', 'eye', 'leaves', 'trunkLit', 'shrub', 'sunward', 'van']),
  },
  {
    title: 'Лес',
    art: 'home-art-forest',
    description:
      'Поляна на адаптивном рельефе: хвойные из ez-tree, ручей, скальные срезы, подрост. Проверка растительности и теней в массе.',
    href: '/?scene=forest',
    open: 'Открыть',
    chips: withLodLab('forest', ['hero', 'wide', 'trail', 'stream', 'ledge', 'canopy', 'rim']),
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
      ...withLodLab('corridor', ['hero', 'wide', 'bench', 'panels', 'floor', 'deep']),
    ],
  },
  {
    title: 'Деревня Мидси',
    art: 'home-art-village',
    preview: '/previews/midsee-village.png',
    description: 'В работе: средиземноморская деревня по концепту. Дома на террасах, колокольня, бухта и кафе на набережной. Превью обновляется по мере сборки.',
    href: '/?scene=midsee-village',
    open: 'Смотреть текущую сцену',
    chips: withLodLab('midsee-village', ['front', 'side', 'rear', 'quay', 'roofs']),
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
      { label: 'lod-lab', href: '/?hud=1&lod=1&lodLab=1' },
      { label: 'split=baked', href: '/?hud=1&split=baked' },
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
  { key: '?lodLab=1', effect: 'Лаба LOD: слева сцена, справа атлас с чартами по требуемому mip. Нужен адрес сцены: /?scene=corridor&cam=bench&lod=1&lodLab=1' },
  { key: '?lod=1', effect: 'LOD лайтмапы: GPU-пул страниц + рабочий атлас, собираемый под вид. ?lodAtlas= размер атласа, ?lodPage= страница, ?lodCopies= копий за кадр.' },
  { key: '?pipeline=legacy', effect: 'Старый конвейер с живыми сурфелями.' },
];
