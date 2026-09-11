import { Note, Part, Shot, Shots, Stage, Take, TakeTable } from '../ui/blocks.tsx';

const BG = 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/';
const ZD = 'https://zhangdoa.com/static/';

const VOLUME_SHOT = `${BG}AVvXsEgUSjq8P8EGGAOezOnx-LExGc6bF5N29VqvXjLOd1Kcuu6lRedChApZ1HwZ_H8LTW62W8v7GQUcvTowm4I4a5NvF-ogtKLsDISj8ARrLfq_eZh86CUKa9_C4CFQ_uOLzMO5l3ehEeOeswVT/w640-h346/016.png`;
const COMPOSITE_SHOT = `${BG}AVvXsEhmeC0YversKNiO5FEbB_CiH9VK9WZenWOZIJfO7Cw54UEvHaKA3sn1UUD6-NwX3MsSlRATUgcq-z0KDuluKx6-ARwfXic97n8KEymYL-FaArqnvhc-XXKuIxR3xv7_VA0J5DMxXUCcSwNz/w640-h180/017.png`;
const PROBE_SHOT = `${BG}AVvXsEi4T0YIJKQNY2CI4hMIFAopAjR86Lsp48XvaWtvMMVypwWdSsr4B8qXiqVVY13aI0oPJ_TYpsOFSjdVOJfkqsqSbtvNHJ624kzluVHcodeYij2Wp5hRy4tP0LULkkT2XJWoELmnwctPKQq6/w400-h362/012.png`;
const SSR_SHOT = `${BG}AVvXsEj9F4CHOnSnTF_jNqXOyBW25QbNDGa28sRHrRG34uuDW1AGP0oWHf2glsg5dmHMFvxeWvNj3wC0xKS3nKxyFnkEHn9_OSidhessylhbTDTIB7L4WLj207ngqvjECyQinpXBROuJV98BGLQR/w640-h360/015.png`;

function GeometryStage() {
  return (
    <Stage k="GB" title="G-буфер и стенсил по классам">
      <Note>
        Четыре цели: альбедо R10G10B10A2 с маской объекта, мировая нормаль R10G10B10A2 как 0.5x+0.5, металличность и
        шероховатость R8G8B8A8, скорость R16G16F, глубина D32S8. Стенсил метит классы: тело 0x15, лицо 0x35, волосы
        0x95, деревья и кусты 0xA0. Порядок: статика, земля и эмиссивное, анимированное, листва, декали, маска меха,
        мех.
      </Note>
    </Stage>
  );
}

export function CyberpunkSection() {
  return (
    <Part
      id="cp2077"
      kicker="Часть 2"
      title="Cyberpunk 2077"
      subtitle="Базой не берём: RDR2 быстрее, а этот на старте почти не запускался и до сих пор жарит карту."
    >
      <div className="col">
        <p>Тот же вопрос решён третьим способом. Структуру не берём, отдельные приёмы берём.</p>
      </div>

      <Stage k="GI" title="Объём облучённости вокруг камеры">
        <Note>
          Набор объёмных текстур <em>64×64×64</em>, центрированных на камере, с индексами в посчитанную облучённость —
          предположительно сферические гармоники. Свет низкочастотный, непрямых теней в пасе нет. Главное: объём един
          для всех объектов, движущихся и нет, и эта согласованность видна в игре.
        </Note>
        <Shots>
          <Shot src={VOLUME_SHOT} alt="Проход непрямого света из объёмной текстуры" width={340}>
            непрямой диффузный из объёма
          </Shot>
          <Shot src={COMPOSITE_SHOT} alt="Итоговая композиция освещения" width={340}>
            итог: диффуз + спекуляр, и спекуляр отдельно
          </Shot>
        </Shots>
      </Stage>

      <Stage k="SPEC" title="Зеркальные пробы, обновляемые по частям">
        <Note>
          Массив текстур с пробами, развёрнутыми сферически или двойным параболоидом, с мипами под GGX. Ключевое:{' '}
          <em>обновляются не все срезы за кадр</em>. Это и есть способ иметь меняющееся освещение, не платя за него
          целиком.
        </Note>
        <Shots>
          <Shot src={PROBE_SHOT} alt="Зеркальная проба в массиве">проба в массиве, мипы под GGX</Shot>
        </Shots>
      </Stage>

      <GeometryStage />

      <Stage k="TAA" title="Motion-stencil против гостинга">
        <Note>
          Отдельный пас метит движущееся, листву и мех по позициям прошлого кадра и расширяет метку на несколько
          пикселей. Приём из Uncharted 4.
        </Note>
        <Shots>
          <Shot src={`${ZD}74009b167326d574c309e592875ca892/b04e4/10_MotionStencil.png`} alt="Буфер motion-stencil" width={340}>
            motion-stencil
          </Shot>
          <Shot src={`${ZD}bfd61773943dff9c65137c94afe8e706/b04e4/12_Noised_Normal.png`} alt="Зашумлённая нормаль" width={340}>
            шумовая нормаль: её читают тень солнца, AO, SSR и небесный свет
          </Shot>
        </Shots>
      </Stage>

      <Stage k="SSR" title="Отражения по упакованной шероховатости">
        <Note>
          В полном разрешении. Нормаль и шероховатость лежат вместе, поэтому пас умеет <em>размытые</em> отражения.
          Читает цвет прошлого кадра с репроекцией по векторам движения.
        </Note>
        <Shots>
          <Shot src={SSR_SHOT} alt="Экранные отражения" width={400}>
            экранные отражения, полное разрешение
          </Shot>
        </Shots>
      </Stage>

      <Stage k="FOG" title="Туман в 3D-текстуре">
        <Note>
          С временной репроекцией; марш ограничен глубиной сцены ради скорости, отсюда протечки. Локальный туман — два
          мипа, 240×136 и 120×68, по 128 слоёв.
        </Note>
      </Stage>

      <div className="col">
        <h3>Что берём, а что нет</h3>
        <TakeTable>
          <Take what="Объём облучённости вокруг камеры" kind="same" verdict="берём форму">
            Но наполняем прогревом, а не пересчётом в кадре
          </Take>
          <Take what="Обновление проб по частям" kind="same" verdict="берём">
            Смена времени суток без полного перепекания
          </Take>
          <Take what="Motion-stencil для TAA" kind="same" verdict="берём">
            Дёшево, лечит гостинг на листве и воде
          </Take>
          <Take what="Размытые SSR по шероховатости" kind="gap" verdict="частично">
            У нас трассировка по BVH точнее
          </Take>
          <Take what="Стенсил по классам материалов" kind="gap" verdict="частично">
            Пригодится, когда классов станет больше двух
          </Take>
          <Take what="Полноэкранный SSR" kind="diff" verdict="нет">
            Часть того, почему игра жарит железо; в вебе бюджета на это нет
          </Take>
        </TakeTable>
      </div>
    </Part>
  );
}
