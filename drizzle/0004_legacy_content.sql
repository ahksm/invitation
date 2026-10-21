-- Данные: содержимое приглашений до Invito (шаблон invite-cover) переводится в поля InvContent.
-- Старые поля: hosts, event, date, time, venue, address, mapUrl, message — строки до 2000 символов.
-- event (заголовок страницы, иначе название приглашения) → names, hosts → host, дата ДД.ММ.ГГГГ → ГГГГ-ММ-ДД,
-- время Ч:ММ → ЧЧ:ММ. Что перевести нельзя (ссылка на карту, дата или время в свободной форме),
-- дописывается в notes, чтобы не потерять. Слишком длинные строки обрезаются по лимитам InvContent.
-- Повторный запуск ничего не меняет: у переведённых записей старых ключей уже нет.
DO $$
DECLARE
  r record;
  d jsonb;
  o jsonb;
  m text[];
  t text;
  iso text;
  extra text[];
  lim record;
BEGIN
  FOR r IN
    SELECT "id", "title", "data" FROM "invitations"
    WHERE jsonb_typeof("data") = 'object' AND "data" ?| ARRAY['hosts', 'event', 'mapUrl']
  LOOP
    d := r."data";
    o := d - ARRAY['hosts', 'event', 'mapUrl', 'date', 'time'];
    extra := ARRAY[]::text[];

    IF NOT o ? 'names' THEN
      t := left(btrim(coalesce(nullif(btrim(d ->> 'event'), ''), r."title", '')), 200);
      IF t <> '' THEN o := o || jsonb_build_object('names', t); END IF;
    END IF;

    t := left(btrim(coalesce(d ->> 'hosts', '')), 200);
    IF t <> '' AND NOT o ? 'host' THEN o := o || jsonb_build_object('host', t); END IF;

    t := btrim(coalesce(d ->> 'date', ''));
    IF t <> '' THEN
      iso := NULL;
      m := regexp_match(t, '^(\d{4})-(\d{1,2})-(\d{1,2})$');
      IF m IS NULL THEN
        m := regexp_match(t, '^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$');
        IF m IS NOT NULL THEN m := ARRAY[m[3], m[2], m[1]]; END IF;
      END IF;
      IF m IS NOT NULL THEN
        BEGIN
          iso := to_char(make_date(m[1]::int, m[2]::int, m[3]::int), 'YYYY-MM-DD');
        EXCEPTION WHEN others THEN
          iso := NULL;
        END;
      END IF;
      IF iso IS NOT NULL THEN o := o || jsonb_build_object('date', iso);
      ELSE extra := extra || t;
      END IF;
    END IF;

    t := btrim(coalesce(d ->> 'time', ''));
    IF t <> '' THEN
      m := regexp_match(t, '^(\d{1,2})[:.](\d{2})$');
      IF m IS NOT NULL AND m[1]::int < 24 AND m[2]::int < 60 THEN
        o := o || jsonb_build_object('time', lpad(m[1], 2, '0') || ':' || m[2]);
      ELSE
        extra := extra || t;
      END IF;
    END IF;

    t := btrim(coalesce(d ->> 'mapUrl', ''));
    IF t <> '' THEN extra := extra || t; END IF;

    IF cardinality(extra) > 0 THEN
      o := o || jsonb_build_object('notes', concat_ws(chr(10), nullif(btrim(coalesce(o ->> 'notes', '')), ''), array_to_string(extra, chr(10))));
    END IF;

    FOR lim IN SELECT * FROM (VALUES ('venue', 200), ('address', 300), ('message', 3000), ('notes', 1000)) AS v(k, n) LOOP
      IF jsonb_typeof(o -> lim.k) = 'string' AND length(o ->> lim.k) > lim.n THEN
        o := o || jsonb_build_object(lim.k, left(o ->> lim.k, lim.n));
      END IF;
    END LOOP;

    UPDATE "invitations" SET "data" = o WHERE "id" = r."id";
  END LOOP;
END $$;
