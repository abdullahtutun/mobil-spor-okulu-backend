import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiException } from './api-error';
import { toApiError } from './all-exceptions.filter';

describe('toApiError', () => {
  it('beklenmeyen hatayı iç ayrıntı sızdırmadan 500 internal yapar', () => {
    const { status, body } = toApiError(new Error('pg: password=gizli'));
    expect(status).toBe(500);
    expect(body).toEqual({
      code: 'internal',
      message: 'Beklenmeyen bir sunucu hatası.',
    });
  });

  it("Nest'in hazır hatalarına durumdan kod verir", () => {
    expect(toApiError(new NotFoundException('Yok'))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Yok' },
    });
  });

  it('dizi mesajı birleştirir ve ayrıntıda tutar', () => {
    const { body } = toApiError(new BadRequestException(['a eksik', 'b kısa']));
    expect(body).toEqual({
      code: 'bad_request',
      message: 'a eksik; b kısa',
      details: ['a eksik', 'b kısa'],
    });
  });

  it('ApiException kodunu, ayrıntısını ve ipucunu aynen taşır', () => {
    const { status, body } = toApiError(
      ApiException.of(HttpStatus.FORBIDDEN, '42501', 'İzin yok', {
        details: { table: 'athletes' },
        hint: 'Rolü kontrol edin',
      }),
    );
    expect(status).toBe(403);
    expect(body).toEqual({
      code: '42501',
      message: 'İzin yok',
      details: { table: 'athletes' },
      hint: 'Rolü kontrol edin',
    });
  });

  it('gövde ayrıştırıcısının hataları 413 / 400 olur, 500 değil', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    });
    expect(toApiError(tooLarge).status).toBe(413);
    const badJson = Object.assign(new SyntaxError('Unexpected end'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    expect(toApiError(badJson)).toEqual({
      status: 400,
      body: { code: 'PGRST102', message: 'Geçersiz ya da boş JSON gövdesi.' },
    });
  });
});
