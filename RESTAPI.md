# CMDBuild REST API

Практическая памятка для поднятого локально CMDBuild stack.

Установленная версия: `itmicus/cmdbuild:4.1.0`.
Используемый API: REST `v3`.
Загруженная база: `demo.dump.xz`.

## Источники

- Официальный Webservice Manual для CMDBuild 4.0:
  https://www.cmdbuild.org/en/documentation/manuals/previous-versions/version-4.0/webservice-manual
- Прямой PDF Webservice Manual 4.0:
  https://www.cmdbuild.org/file/manuali/versione-4.0/cmdbuild_webservicemanual_eng_v40.pdf
- Страница manuals: онлайн-документация начинается с CMDBuild 4.2, для более ранних версий используются PDF manuals:
  https://www.cmdbuild.org/en/documentation/manuals
- Release note CMDBuild 4.1:
  https://www.cmdbuild.org/en/reference/news/cmdbuild-4-1-release-now-available
- Примеры синтаксиса фильтров из форума CMDBuild:
  https://forum.cmdbuild.org/t/wsqueryoptions-in-rest-api-v3/5248

Примечание: отдельный официальный Webservice Manual именно для `4.1.0` не найден. CMDBuild 4.1 использует REST `v3`; официальный 4.0 Webservice Manual описывает тот же REST `v3` слой, а примеры ниже дополнительно проверены на установленном локальном `4.1.0`.

## Base URL

Локально на сервере:

```sh
BASE='http://127.0.0.1:8090/cmdbuild/services/rest/v3'
```

Снаружи, после публикации CMDBuild на все интерфейсы:

```sh
BASE='http://192.168.202.100:8090/cmdbuild/services/rest/v3'
```

Альтернативный интерфейс, если клиент находится в соответствующей сети/VPN:

```sh
BASE='http://10.66.66.6:8090/cmdbuild/services/rest/v3'
```

Проверка готовности системы:

```sh
curl -sS "$BASE/boot/status" | jq .
```

Ожидаемый ответ:

```json
{
  "success": true,
  "status": "READY"
}
```

## Формат запросов

CMDBuild REST API работает поверх HTTP и JSON.

Типовые методы:

- `GET` - чтение списков и отдельных объектов.
- `POST` - создание объектов, запуск операций.
- `PUT` - изменение существующих объектов.
- `DELETE` - удаление объектов.

Типовой ответ:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

При ошибке:

```json
{
  "success": false,
  "messages": [
    {
      "level": "ERROR",
      "show_user": true,
      "message": "access denied"
    }
  ]
}
```

## Авторизация

Для большинства endpoint нужен session token. Токен получается через `POST /sessions`.

Для текущего dev stack проверенный администратор:

- user: `admin`
- password: `admin`

В production пароль нужно заменить сразу после первого входа.

Получить token:

```sh
TOKEN=$(
  curl -sS --location "$BASE/sessions?scope=service&returnId=true" \
    -H 'Content-Type: application/json' \
    --data '{"username":"admin","password":"admin"}' \
  | jq -r '.data._id'
)

echo "$TOKEN"
```

Почему важен `returnId=true`: начиная с REST v3.2, если не передать `returnId=true`, сервер скрывает реальный session id и возвращает `current`.

Использовать token в последующих запросах:

```sh
curl -sS "$BASE/classes?scope=service&limit=20" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Поддерживать сессию живой:

```sh
curl -sS -X POST "$BASE/sessions/$TOKEN/keepalive" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Закрыть сессию:

```sh
curl -sS -X DELETE "$BASE/sessions/$TOKEN" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

## Основные сущности CMDBuild

В CMDBuild объектная модель строится вокруг:

- `classes` - классы данных, аналог таблиц/типов CI.
- `cards` - экземпляры классов, то есть конкретные объекты.
- `domains` - типы связей между классами.
- `relations` - конкретные связи между cards.
- `attributes` - поля classes и domains.
- `lookups` - справочники закрытых значений.
- `processes` и `instances` - workflow-процессы и их экземпляры.
- `users`, `roles`, `grants` - пользователи, роли и права.

В загруженной demo-базе проверены классы:

- `Employee`
- `Asset`
- `Monitor`
- `PC`
- `Building`
- `Floor`
- `Room`
- `Office`
- `Supplier`
- `Invoice`

И домены:

- `AssetAssignee`: `Employee -> Asset`
- `AssetReference`: `Employee -> Asset`
- `BuildingFloor`: `Building -> Floor`
- `FloorRoom`: `Floor -> Room`
- `OfficeRoom`: `Office -> Room`
- `RoomAsset`: `Room -> Asset`

## Стандартные query params

Многие списочные endpoint принимают `StandardQueryParams`:

- `attrs` - список возвращаемых атрибутов.
- `filter` - JSON-фильтр, переданный как строка query parameter.
- `sort` - JSON/строка сортировки.
- `limit` - ограничение количества результатов.
- `offset` или `start` - смещение результата.
- `detailed` - вернуть более подробный ответ.
- `positionOf` - вернуть позицию объекта в `meta`.

Пример пагинации и выбора атрибутов:

```sh
curl -sS "$BASE/classes/Employee/cards?scope=service&limit=5&start=0&attrs=Code,Description,Email" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

## Классы

Получить список классов:

```sh
curl -sS "$BASE/classes?scope=service&limit=50" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, description, active}'
```

Получить описание конкретного класса:

```sh
curl -sS "$BASE/classes/Employee?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Получить атрибуты класса:

```sh
curl -sS "$BASE/classes/Employee/attributes?scope=service&limit=100" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, type, active}'
```

## Чтение cards

Получить первые 5 сотрудников:

```sh
curl -sS "$BASE/classes/Employee/cards?scope=service&limit=5" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Получить конкретную card:

```sh
curl -sS "$BASE/classes/Employee/cards/134?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

В demo-базе card `Employee/134` - `Taylor William`.

Получить карточки класса-наследника. Например asset `MON0001` имеет реальный `_type=Monitor`, поэтому для некоторых операций лучше обращаться к конкретному классу:

```sh
curl -sS "$BASE/classes/Monitor/cards/550?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

## Фильтрация cards

Параметр `filter` передается как URL-encoded JSON string.

Простой фильтр `Description contains Taylor`:

```json
{
  "attribute": {
    "simple": {
      "attribute": "Description",
      "operator": "contain",
      "value": ["Taylor"],
      "parameterType": "fixed"
    }
  }
}
```

Команда:

```sh
FILTER='{"attribute":{"simple":{"attribute":"Description","operator":"contain","value":["Taylor"],"parameterType":"fixed"}}}'

curl -sS --get "$BASE/classes/Employee/cards" \
  -H "CMDBuild-Authorization: $TOKEN" \
  --data-urlencode 'scope=service' \
  --data-urlencode 'limit=5' \
  --data-urlencode "filter=$FILTER" \
  | jq .
```

Равенство по `Code`:

```sh
FILTER='{"attribute":{"simple":{"attribute":"Code","operator":"equal","value":["10"],"parameterType":"fixed"}}}'

curl -sS --get "$BASE/classes/Employee/cards" \
  -H "CMDBuild-Authorization: $TOKEN" \
  --data-urlencode 'scope=service' \
  --data-urlencode "filter=$FILTER" \
  | jq .
```

Сложный фильтр через `and`:

```json
{
  "attribute": {
    "and": [
      {
        "simple": {
          "attribute": "Description",
          "operator": "contain",
          "value": ["Taylor"],
          "parameterType": "fixed"
        }
      },
      {
        "simple": {
          "attribute": "State",
          "operator": "equal",
          "value": [24],
          "parameterType": "fixed"
        }
      }
    ]
  }
}
```

Типовые операторы, встречающиеся в CMDBuild REST v3 filters:

- `equal`
- `notequal`
- `isnull`
- `isnotnull`
- `greater`
- `less`
- `between`
- `like`
- `contain`
- `notcontain`
- `begin`
- `notbegin`
- `end`
- `notend`
- `in`

На разных версиях встречается разный регистр операторов (`equal`/`EQUAL`). На установленном CMDBuild 4.1.0 проверен нижний регистр: `equal`, `contain`.

## Создание cards

Endpoint:

```text
POST /classes/{classId}/cards
```

Тело запроса - JSON object с атрибутами class. Перед созданием проверьте обязательные атрибуты:

```sh
curl -sS "$BASE/classes/Employee/attributes?scope=service&limit=100" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, type, mandatory}'
```

Пример создания `Employee` в demo-базе:

```sh
curl -sS -X POST "$BASE/classes/Employee/cards?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "Code": "API001",
    "Description": "API User",
    "Surname": "User",
    "Name": "API",
    "Email": "api.user@example.com"
  }' \
  | jq .
```

Ответ вернет созданную card, включая `_id`. Сохраните `_id`, он нужен для update/delete и связей.

## Изменение cards

Endpoint:

```text
PUT /classes/{classId}/cards/{cardId}
```

Пример изменения email:

```sh
curl -sS -X PUT "$BASE/classes/Employee/cards/134?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "Email": "william.taylor+api@example.com"
  }' \
  | jq .
```

Практически безопаснее отправлять все значимые поля, если вы не уверены, как конкретная версия/endpoint обрабатывает частичный update:

```sh
curl -sS "$BASE/classes/Employee/cards/134?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data'
```

Затем изменить нужные поля и отправить JSON через `PUT`.

## Удаление cards

Endpoint:

```text
DELETE /classes/{classId}/cards/{cardId}
```

Пример:

```sh
curl -sS -X DELETE "$BASE/classes/Employee/cards/NEW_CARD_ID?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Не удаляйте demo cards, если на них есть связи или они нужны для проверки интерфейса.

## Массовое изменение и удаление cards

Webservice Manual указывает, что для `/classes/{classId}/cards` доступны:

- `PUT` со `StandardQueryParams` и JSON body - массовое изменение cards.
- `DELETE` со `StandardQueryParams` - массовое удаление cards.

Используйте только с очень точным `filter`.

Пример шаблона массового update:

```sh
FILTER='{"attribute":{"simple":{"attribute":"Code","operator":"begin","value":["API"],"parameterType":"fixed"}}}'
FILTER_ENCODED=$(jq -rn --arg value "$FILTER" '$value|@uri')

curl -sS -X PUT "$BASE/classes/Employee/cards?scope=service&filter=$FILTER_ENCODED" \
  -H "CMDBuild-Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"Notes":"Updated through REST API"}' \
  | jq .
```

Этот шаблон приведен как ориентир для тестовой среды. Перед массовым `PUT` или `DELETE` сначала выполните тот же `filter` через `GET` и убедитесь, что выборка содержит только нужные cards.

## Domains

Получить список domains:

```sh
curl -sS "$BASE/domains?scope=service&limit=100" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, description}'
```

Получить конкретный domain:

```sh
curl -sS "$BASE/domains/AssetAssignee?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Для demo-базы:

- `AssetAssignee`: source `Employee`, destination `Asset`.
- `AssetReference`: source `Employee`, destination `Asset`, имеет атрибут domain `Role`.

Атрибуты domain:

```sh
curl -sS "$BASE/domains/AssetReference/attributes?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, type, active}'
```

## Чтение relations через card

Endpoint:

```text
GET /classes/{classId}/cards/{cardId}/relations
```

Пример: все связи сотрудника `Employee/134`:

```sh
curl -sS "$BASE/classes/Employee/cards/134/relations?scope=service&limit=10&detailed=true" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Проверенный результат на demo-базе содержит, например:

- relation `_id=553`
- `_type=AssetAssignee`
- `_sourceType=Employee`
- `_sourceId=134`
- `_destinationType=Monitor`
- `_destinationId=550`

Для обратного направления используйте реальный class card. Например monitor `550`:

```sh
curl -sS "$BASE/classes/Monitor/cards/550/relations?scope=service&limit=10&detailed=true" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

В ответе relation будет с `_direction=inverse` и `_is_direct=false`, потому что domain задан как `Employee -> Asset`, а запрос идет от `Monitor`.

## Чтение relations через domain

Endpoint:

```text
GET /domains/{domainId}/relations
GET /domains/{domainId}/relations/{relationId}
```

Все связи domain `AssetAssignee`:

```sh
curl -sS "$BASE/domains/AssetAssignee/relations?scope=service&limit=5&detailed=true" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Конкретная relation:

```sh
curl -sS "$BASE/domains/AssetAssignee/relations/553?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

## Создание relations

Есть два равнозначных подхода:

```text
POST /classes/{classId}/cards/{cardId}/relations
POST /domains/{domainId}/relations
```

Практически удобнее создавать через domain, потому что явно видно тип связи.

Минимальное тело для relation:

```json
{
  "_type": "AssetAssignee",
  "_sourceType": "Employee",
  "_sourceId": 134,
  "_destinationType": "Monitor",
  "_destinationId": 550
}
```

Команда:

```sh
curl -sS -X POST "$BASE/domains/AssetAssignee/relations?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "_type": "AssetAssignee",
    "_sourceType": "Employee",
    "_sourceId": 134,
    "_destinationType": "Monitor",
    "_destinationId": 550
  }' \
  | jq .
```

Не выполняйте этот пример повторно на demo-базе без проверки: такая relation уже существует (`_id=553`).

Для domain с атрибутами добавьте атрибуты domain в тот же JSON. Например `AssetReference` имеет атрибут `Role`:

```json
{
  "_type": "AssetReference",
  "_sourceType": "Employee",
  "_sourceId": 134,
  "_destinationType": "PC",
  "_destinationId": 534,
  "Role": 123
}
```

Где `Role` должен быть id lookup value соответствующего lookup-справочника.

## Изменение relations

Endpoint:

```text
PUT /domains/{domainId}/relations/{relationId}
```

Для relation update важно передавать системные поля relation, включая `_type`, source/destination, и изменяемые атрибуты domain. Если отправить только пользовательский атрибут, сервер может вернуть ошибку из-за отсутствия `_type`.

Сначала получите текущую relation:

```sh
curl -sS "$BASE/domains/AssetReference/relations/540?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data'
```

Затем отправьте измененную версию:

```sh
curl -sS -X PUT "$BASE/domains/AssetReference/relations/540?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "_id": 540,
    "_type": "AssetReference",
    "_sourceType": "Employee",
    "_sourceId": 134,
    "_destinationType": "PC",
    "_destinationId": 534,
    "Role": null
  }' \
  | jq .
```

## Удаление relations

Endpoint:

```text
DELETE /domains/{domainId}/relations/{relationId}
```

Пример:

```sh
curl -sS -X DELETE "$BASE/domains/AssetAssignee/relations/RELATION_ID?scope=service" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Удаление relation не удаляет cards, только связь между ними.

## История cards и relations

История card:

```sh
curl -sS "$BASE/classes/Employee/cards/134/history?scope=service&limit=20" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

История relation:

```sh
curl -sS "$BASE/domains/AssetAssignee/relations/553/history?scope=service&limit=20" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

## Attachments

Endpoint cards attachments:

```text
/classes/{classId}/cards/{cardId}/attachments
```

Список attachments:

```sh
curl -sS "$BASE/classes/Employee/cards/134/attachments?scope=service&limit=20" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

Загрузка файла обычно выполняется multipart-запросом с metadata JSON и binary file. Точную структуру см. в Webservice Manual, раздел `Card Attachments`.

## Users и roles

Список пользователей:

```sh
curl -sS "$BASE/users?scope=service&limit=50" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {username, description, active}'
```

Список ролей:

```sh
curl -sS "$BASE/roles?scope=service&limit=50" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, description, active}'
```

## Processes

Список процессов:

```sh
curl -sS "$BASE/processes?scope=service&limit=50" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, description, active}'
```

Список process instances:

```sh
curl -sS "$BASE/processes/{processId}/instances?scope=service&limit=20" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq .
```

CMDBuild разделяет классы/cards и процессы/instances, но в Webservice Manual многие endpoint показаны как `classes|processes`, то есть одинаковая логика применима к обоим типам.

## Практический workflow интеграции

1. Проверить доступность:

```sh
curl -sS "$BASE/boot/status" | jq .
```

2. Получить token:

```sh
TOKEN=$(
  curl -sS --location "$BASE/sessions?scope=service&returnId=true" \
    -H 'Content-Type: application/json' \
    --data '{"username":"admin","password":"admin"}' \
  | jq -r '.data._id'
)
```

3. Найти class:

```sh
curl -sS "$BASE/classes?scope=service&limit=100" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | .name'
```

4. Найти атрибуты class:

```sh
curl -sS "$BASE/classes/Employee/attributes?scope=service&limit=100" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {name, type}'
```

5. Найти cards:

```sh
FILTER='{"attribute":{"simple":{"attribute":"Description","operator":"contain","value":["Taylor"],"parameterType":"fixed"}}}'

curl -sS --get "$BASE/classes/Employee/cards" \
  -H "CMDBuild-Authorization: $TOKEN" \
  --data-urlencode 'scope=service' \
  --data-urlencode "filter=$FILTER" \
  | jq '.data[] | {_id, _type, Code, Description}'
```

6. Получить связи card:

```sh
curl -sS "$BASE/classes/Employee/cards/134/relations?scope=service&detailed=true" \
  -H "CMDBuild-Authorization: $TOKEN" \
  | jq '.data[] | {_id, _type, _sourceType, _sourceId, _destinationType, _destinationId}'
```

7. Изменить card или relation через `PUT`, предварительно сохранив текущий JSON.

## Безопасность

- Не используйте `admin/admin` для внешних интеграций.
- Создайте отдельного service user с минимальными grants.
- Публикация CMDBuild сейчас открыта на `0.0.0.0:8090`; ограничьте доступ firewall/proxy, если сервер виден за пределами доверенной сети.
- Для production используйте HTTPS reverse proxy.
- Не логируйте `CMDBuild-Authorization` token.
- Проверяйте `success=false` и `messages[]` в каждом ответе.

## Проверено локально

На текущем stack проверены:

- `GET /boot/status` -> `success=true`, `status=READY`.
- `POST /sessions?scope=service&returnId=true` с `admin/admin` -> получен token.
- `GET /classes` -> классы demo-базы возвращаются.
- `GET /domains` -> domains demo-базы возвращаются.
- `GET /classes/Employee/cards` -> возвращает cards, включая `Employee/134`.
- `GET /classes/Employee/cards` с `filter Description contain Taylor` -> возвращает `Taylor William`.
- `GET /classes/Employee/cards/134/relations?detailed=true` -> возвращает relations, включая `AssetAssignee/553`.
- `GET /domains/AssetReference/relations/540` -> возвращает relation с domain attribute `Role`.
