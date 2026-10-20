// Каталог дорожных знаков: тип в сценарии → узел из набора моделей (assets/models/env).
// Общий для браузера (props.js) и проверки сценария (validate.mjs), поэтому без three.js.
// Наборы: «Modular Russian Road Signs Pack (URBAN)» — Unka II, «Модульный набор дорожных знаков (Дополнение)» — Staks, оба CC-BY-4.0.
export const SIGN_PACKS = {
  urban: 'env/ru_signs_urban.glb',
  extra: 'env/ru_signs_extra.glb',
};

// node — имя узла; crop: 'top' — в узле два одинаковых знака друг над другом, берётся верхний
export const SIGNS = {
  // знаки приоритета
  main_road: { pdd: '2.1 Главная дорога', node: 'MainRoad' },
  end_main_road: { pdd: '2.2 Конец главной дороги', pack: 'extra', node: 'Object_6', crop: 'top' },
  yield: { pdd: '2.4 Уступите дорогу', node: 'Plane002' },
  stop: { pdd: '2.5 Движение без остановки запрещено' },   // нет в наборе — рисуется сам
  // предупреждающие
  speed_bump_ahead: { pdd: '1.17 Искусственная неровность', node: 'Plane014' },
  tram_crossing: { pdd: '1.5 Пересечение с трамвайной линией', node: 'Plane001' },
  children: { pdd: '1.23 Дети', node: 'Children' },
  // запрещающие
  no_entry: { pdd: '3.1 Въезд запрещён', node: 'NoEntry' },
  no_vehicles: { pdd: '3.2 Движение запрещено', node: 'novehicles' },
  no_trucks: { pdd: '3.4 Движение грузовых автомобилей запрещено', node: 'NoTrucks' },
  no_right: { pdd: '3.18.1 Поворот направо запрещён', node: 'NoRight' },
  no_left: { pdd: '3.18.2 Поворот налево запрещён', node: 'NoLeft' },
  no_u_turn: { pdd: '3.19 Разворот запрещён', node: 'NoTurn' },
  speed_limit_40: { pdd: '3.24 Ограничение скорости 40', node: 'SpeedLimit' },
  no_stopping: { pdd: '3.27 Остановка запрещена', node: 'NoStoppng' },
  no_parking: { pdd: '3.28 Стоянка запрещена', node: 'NoParking' },
  no_parking_odd: { pdd: '3.29 Стоянка запрещена по нечётным числам', node: 'NoParkingI' },
  no_parking_even: { pdd: '3.30 Стоянка запрещена по чётным числам', node: 'NoParkingII' },
  // предписывающие
  straight: { pdd: '4.1.1 Движение прямо', node: 'GoStraight' },
  straight_or_right: { pdd: '4.1.4 Движение прямо или направо', node: 'GoStraightOrRight' },
  keep_right: { pdd: '4.2.1 Объезд препятствия справа', node: 'TurnRight' },
  keep_either: { pdd: '4.2.3 Объезд препятствия справа или слева', node: 'BothSides' },
  roundabout: { pdd: '4.3 Круговое движение', node: 'RoundTraffic' },
  // особых предписаний и информационные
  motorway: { pdd: '5.1 Автомагистраль', pack: 'extra', node: 'Object_2', crop: 'top' },
  end_motorway: { pdd: '5.2 Конец автомагистрали', pack: 'extra', node: 'Object_5', crop: 'top' },
  one_way: { pdd: '5.5 Дорога с односторонним движением', node: 'oneWay' },
  bus_stop: { pdd: '5.16 Место остановки автобуса', node: 'BusStop' },
  tram_stop: { pdd: '5.17 Место остановки трамвая', node: 'TramStop' },
  ped_crossing: { pdd: '5.19.1 Пешеходный переход', node: 'RoadCrossing' },
  speed_bump: { pdd: '5.20 Искусственная неровность', node: 'SpeedBump' },
  living_zone: { pdd: '5.21 Жилая зона', node: 'Yard' },
  parking: { pdd: '6.4 Парковка', node: 'Parking' },
  underpass: { pdd: '6.7 Подземный пешеходный переход', node: 'Underground' },
  hospital: { pdd: '7.2 Больница', node: 'Hospital' },
  gas_station: { pdd: '7.3 АЗС', node: 'GAS' },
};

// таблички (знаки дополнительной информации) — вешаются под знак: "plate": "main_direction"
export const PLATES = {
  main_direction: { pdd: '8.13 Направление главной дороги', node: 'MainDirect' },
  main_direction_2: { pdd: '8.13 Направление главной дороги (вариант)', node: 'RoundDirect' },
  zone_100: { pdd: '8.2.1 Зона действия 100 м', node: '_area' },
  distance_300: { pdd: '8.1.1 Расстояние до объекта 300 м', node: '_distancetoobject' },
  bus: { pdd: '8.4 Вид транспорта: автобус', node: '_busonly' },
  car: { pdd: '8.4 Вид транспорта: легковой', node: '_carsonly' },
  truck: { pdd: '8.4 Вид транспорта: грузовой', node: '_trucksonly' },
  disabled: { pdd: '8.17 Инвалиды', node: '_diasbledpeople' },
};
