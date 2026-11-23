import { buildCallSql, matchSignature, quoteIdent } from './rpc-call';
import type { RpcSignature } from './rpc-catalog.service';

const consents: RpcSignature = {
  name: 'parent_set_consents',
  params: [
    { name: 'p_athlete_id', type: 'uuid', hasDefault: false },
    { name: 'p_health', type: 'boolean', hasDefault: true },
    { name: 'p_photo', type: 'boolean', hasDefault: true },
  ],
  returnsSet: false,
  returnsVoid: false,
};

describe('matchSignature', () => {
  it('zorunlular gönderildiyse, varsayılanlılar eksik olsa da eşleşir', () => {
    expect(matchSignature([consents], ['p_athlete_id']).match).toBe(consents);
    expect(matchSignature([consents], ['p_athlete_id', 'p_photo']).match).toBe(
      consents,
    );
  });

  it('bilinmeyen anahtar ya da eksik zorunlu parametre eşleşmez', () => {
    expect(
      matchSignature([consents], ['p_athlete_id', 'p_x']).match,
    ).toBeUndefined();
    expect(matchSignature([consents], ['p_photo']).match).toBeUndefined();
  });

  it('iki overload da uyarsa belirsizdir', () => {
    const other = { ...consents, params: consents.params.slice(0, 1) };
    expect(matchSignature([consents, other], ['p_athlete_id']).ambiguous).toBe(
      true,
    );
  });
});

describe('buildCallSql', () => {
  it('yalnızca gönderilen parametreleri, adlarıyla ve tipleriyle yazar', () => {
    expect(buildCallSql(consents, ['p_photo', 'p_athlete_id'])).toBe(
      'select to_json(_r) as result from json_to_record($1::json) as _a(' +
        '"p_athlete_id" uuid, "p_photo" boolean), lateral ' +
        'public."parent_set_consents"("p_athlete_id" => _a."p_athlete_id", ' +
        '"p_photo" => _a."p_photo") as _r',
    );
  });

  it('parametresiz çağrı $1 kullanmaz', () => {
    expect(
      buildCallSql({ ...consents, name: 'get_session_data', params: [] }, []),
    ).toBe(
      'select to_json(_r) as result from public."get_session_data"() as _r',
    );
  });

  it('setof dizi, void null döndürür', () => {
    expect(buildCallSql({ ...consents, returnsSet: true }, [])).toContain(
      "coalesce(json_agg(_r), '[]'::json)",
    );
    expect(
      buildCallSql({ ...consents, params: [], returnsVoid: true }, []),
    ).toBe('select public."parent_set_consents"(), null::json as result');
  });

  it('tanımlayıcı tırnağı kaçırılır', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});
