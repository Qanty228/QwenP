import { test } from 'node:test';
import assert from 'node:assert';
import {
  decodeJwtPayload,
  extractBearerToken,
  getBearerTokenExpiryMs,
  hasExpiredBearerToken,
  isBearerTokenExpired,
} from '../../utils/access-token.js';

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

test('access token: extracts the raw JWT from an authorization header', () => {
  const jwt = makeJwt({ exp: nowSeconds() + 600 });
  assert.strictEqual(extractBearerToken(`Bearer ${jwt}`), jwt);
  assert.strictEqual(extractBearerToken(`bearer ${jwt}`), jwt);
  assert.strictEqual(extractBearerToken(`Bearer  ${jwt}  `), jwt);
});

test('access token: returns null for a missing or non-bearer header', () => {
  assert.strictEqual(extractBearerToken(undefined), null);
  assert.strictEqual(extractBearerToken(null), null);
  assert.strictEqual(extractBearerToken(''), null);
  assert.strictEqual(extractBearerToken('Basic abc123'), null);
});

test('access token: decodes the JWT payload', () => {
  const payload = decodeJwtPayload(makeJwt({ id: 'abc', exp: 123 }));
  assert.strictEqual((payload as Record<string, unknown>)?.id, 'abc');
  assert.strictEqual(payload?.exp, 123);
});

test('access token: decodes malformed JWTs as null', () => {
  assert.strictEqual(decodeJwtPayload('not-a-jwt'), null);
  assert.strictEqual(decodeJwtPayload('a.b.c'), null);
});

test('access token: reads the expiry as a millisecond timestamp', () => {
  const exp = nowSeconds() + 900;
  const header = `Bearer ${makeJwt({ exp })}`;
  assert.strictEqual(getBearerTokenExpiryMs(header), exp * 1000);
  assert.strictEqual(getBearerTokenExpiryMs(undefined), null);
  assert.strictEqual(getBearerTokenExpiryMs('Bearer opaque-token'), null);
});

test('access token: reports a fresh token as valid', () => {
  const header = `Bearer ${makeJwt({ exp: nowSeconds() + 900 })}`;
  assert.strictEqual(isBearerTokenExpired(header), false);
});

test('access token: reports an expired token as expired', () => {
  const header = `Bearer ${makeJwt({ exp: nowSeconds() - 60 })}`;
  assert.strictEqual(isBearerTokenExpired(header), true);
});

test('access token: applies a safety skew before the expiry', () => {
  // Within the skew window the token is treated as expired so requests are
  // not started with a token that would die mid-flight.
  const almostExpired = `Bearer ${makeJwt({ exp: nowSeconds() + 10 })}`;
  assert.strictEqual(isBearerTokenExpired(almostExpired), true);
  assert.strictEqual(isBearerTokenExpired(almostExpired, 0), false);

  const clearlyValid = `Bearer ${makeJwt({ exp: nowSeconds() + 300 })}`;
  assert.strictEqual(isBearerTokenExpired(clearlyValid), false);
});

test('access token: treats tokens without a readable expiry as valid', () => {
  assert.strictEqual(isBearerTokenExpired('Bearer opaque-token'), false);
  assert.strictEqual(isBearerTokenExpired(undefined), false);
});

test('access token: header helper detects an expired bearer token', () => {
  const expired = { authorization: `Bearer ${makeJwt({ exp: nowSeconds() - 60 })}` };
  const fresh = { authorization: `Bearer ${makeJwt({ exp: nowSeconds() + 900 })}` };
  assert.strictEqual(hasExpiredBearerToken(expired), true);
  assert.strictEqual(hasExpiredBearerToken(fresh), false);
});

test('access token: header helper ignores headers without a bearer token', () => {
  assert.strictEqual(hasExpiredBearerToken({ cookie: 'token=x' }), false);
  assert.strictEqual(hasExpiredBearerToken({}), false);
  assert.strictEqual(hasExpiredBearerToken(undefined), false);
});
