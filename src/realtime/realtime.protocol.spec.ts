import {
  parseClientMessage,
  parseNotificationChange,
} from './realtime.protocol';

const ID = 'a0000000-0000-4000-8000-0000000000a8';

describe('realtime protokolü', () => {
  it.each([
    ['{"type":"auth","token":"x"}', { type: 'auth', token: 'x' }],
    [
      `{"type":"subscribe","channel":"notifications:${ID}"}`,
      { type: 'subscribe', channel: `notifications:${ID}` },
    ],
    [
      '{"type":"unsubscribe","channel":"c"}',
      { type: 'unsubscribe', channel: 'c' },
    ],
    ['{"type":"ping"}', { type: 'ping' }],
  ])('%s', (raw, expected) => {
    expect(parseClientMessage(raw)).toEqual(expected);
  });

  it.each([
    'değil json',
    '[]',
    'null',
    '{"type":"auth"}',
    '{"type":"auth","token":""}',
    '{"type":"subscribe","channel":5}',
    '{"type":"phx_join"}',
  ])('reddedilir: %s', (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('NOTIFY yükü', () => {
    expect(
      parseNotificationChange(
        JSON.stringify({
          op: 'INSERT',
          id: ID.toUpperCase(),
          recipient_id: ID,
        }),
      ),
    ).toEqual({ op: 'INSERT', id: ID, recipientId: ID });
    expect(parseNotificationChange('{"op":"DELETE","id":"x"}')).toBeNull();
    expect(parseNotificationChange(`{"op":"UPDATE","id":"${ID}"}`)).toBeNull();
    expect(parseNotificationChange('')).toBeNull();
  });
});
