import { DatabaseError } from 'pg';
import { pgErrorStatus, pgErrorToApiException } from './pg-error.mapper';

describe('pgErrorStatus (PostgREST ile aynı)', () => {
  it.each([
    ['P0001', true, 400],
    ['42501', true, 403],
    ['42501', false, 401],
    ['23505', true, 409],
    ['23503', true, 409],
    ['23502', true, 400],
    ['22P02', true, 400],
    ['42883', true, 404],
    ['57014', true, 500],
    ['08006', true, 503],
    ['40001', true, 500],
    ['XX000', true, 500],
  ])('%s (oturumlu: %s) → %i', (state, authenticated, status) => {
    expect(pgErrorStatus(state, authenticated)).toBe(status);
  });
});

describe('pgErrorToApiException', () => {
  it('gövde: code = SQLSTATE, message, details ve hint (yoksa null)', () => {
    const error = new DatabaseError('Sporcu bulunamadı', 0, 'error');
    error.code = 'P0001';
    error.detail = 'ayrıntı';
    const exception = pgErrorToApiException(error, true);
    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual({
      code: 'P0001',
      message: 'Sporcu bulunamadı',
      details: 'ayrıntı',
      hint: null,
    });
  });
});
