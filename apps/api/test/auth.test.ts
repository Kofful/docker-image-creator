import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse } from '@docker-image-creator/contracts';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

let app: INestApplication;
const password = 'a-long-test-password';
const origin = 'http://127.0.0.1:8080';

beforeEach(async () => {
  assert.equal(process.env.AUTH_TEST_RUN, '1', 'Use the disposable MySQL test harness');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
});

afterEach(async () => { await app?.close(); });

function credentials() { return { email: `${randomUUID()}@example.com`, password }; }

async function register(input = credentials()): Promise<AuthResponse> {
  const response = await request(app.getHttpServer()).post('/api/v1/auth/register').send(input).expect(201);
  return response.body as AuthResponse;
}

function me(accessToken: string) {
  return request(app.getHttpServer()).get('/api/v1/auth/me').auth(accessToken, { type: 'bearer' });
}

function refresh(refreshToken: string) {
  return request(app.getHttpServer()).post('/api/v1/auth/refresh_token').send({ refresh_token: refreshToken });
}

test('registration returns tokens that authorize the current user', async () => {
  const email = credentials().email;
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password })
    .expect(201);
  assert.equal(response.body.user.email, email);
  assert.equal(response.body.token_type, 'Bearer');
  assert.equal(response.body.expires_in, 900);
  assert.equal(typeof response.body.refresh_token, 'string');
  const me = await request(app.getHttpServer())
    .get('/api/v1/auth/me')
    .auth(response.body.access_token, { type: 'bearer' })
    .expect(200);
  assert.deepEqual(me.body, response.body.user);
  assert.equal('passwordHash' in me.body, false);
  assert.equal('password' in response.body.user, false);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
});

test('login normalizes email and authenticates the registered password', async () => {
  const input = credentials();
  const registered = await register(input);
  const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
    .set('Origin', origin).send({ ...input, email: `  ${input.email.toUpperCase()}  ` }).expect(200);
  assert.deepEqual(response.body.user, registered.user);
  assert.notEqual(response.body.access_token, registered.access_token);
  assert.notEqual(response.body.refresh_token, registered.refresh_token);
  await me(response.body.access_token).expect(200);
});

test('registration normalizes email and rejects an existing normalized address', async () => {
  const input = credentials();
  const first = await register({ ...input, email: ` ${input.email.toUpperCase()} ` });
  assert.equal(first.user.email, input.email);
  await request(app.getHttpServer()).post('/api/v1/auth/register').send(input).expect(409);
});

test('concurrent registration of the same email creates one account', async () => {
  const input = credentials();
  const responses = await Promise.all([1, 2].map(() => request(app.getHttpServer())
    .post('/api/v1/auth/register').send(input)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(200);
});

test('invalid login uses the same error for unknown email and wrong password', async () => {
  const input = credentials();
  await register(input);
  const wrong = await request(app.getHttpServer()).post('/api/v1/auth/login')
    .send({ ...input, password: 'incorrect-password' }).expect(401);
  const unknown = await request(app.getHttpServer()).post('/api/v1/auth/login')
    .send(credentials()).expect(401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.body.message, 'Invalid email or password');
});

for (const path of ['register', 'login']) {
  test(`${path} rejects malformed, oversized and unknown credentials`, async () => {
    const input = credentials();
    for (const body of [
      {}, { ...input, email: 'invalid' }, { ...input, email: 1 },
      { ...input, password: 'short' }, { ...input, password: 'p'.repeat(129) },
      { ...input, password: null }, { ...input, admin: true },
    ]) {
      const response = await request(app.getHttpServer()).post(`/api/v1/auth/${path}`).send(body).expect(400);
      assert.equal(JSON.stringify(response.body).includes(password), false);
    }
  });
}

test('password whitespace is preserved', async () => {
  const input = { ...credentials(), password: ` ${password} ` };
  await register(input);
  await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(200);
  await request(app.getHttpServer()).post('/api/v1/auth/login').send({ ...input, password }).expect(401);
});

test('refresh returns a new usable token pair for the same user', async () => {
  const first = await register();
  const response = await refresh(first.refresh_token).expect(200);
  assert.deepEqual(response.body.user, first.user);
  assert.notEqual(response.body.refresh_token, first.refresh_token);
  assert.notEqual(response.body.access_token, first.access_token);
  assert.equal(response.headers['cache-control'], 'no-store');
  await me(response.body.access_token).expect(200);
  await refresh(response.body.refresh_token).expect(200);
});

test('replaying a consumed refresh token revokes its entire session', async () => {
  const first = await register();
  const rotated = await refresh(first.refresh_token).expect(200);
  await refresh(first.refresh_token).expect(401);
  await me(first.access_token).expect(401);
  await me(rotated.body.access_token).expect(401);
  await refresh(rotated.body.refresh_token).expect(401);
});

test('concurrent refresh consumes a token once and revokes the session on replay', async () => {
  const first = await register();
  const responses = await Promise.all([refresh(first.refresh_token), refresh(first.refresh_token)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  await me(first.access_token).expect(401);
  const rotated = responses.find((response) => response.status === 200);
  assert.ok(rotated);
  await refresh(rotated.body.refresh_token).expect(401);
});

test('refresh rejects missing, malformed, unknown and access tokens', async () => {
  const tokens = await register();
  for (const body of [{}, { refresh_token: 5 }, { refresh_token: 'bad' },
    { refresh_token: tokens.access_token }, { refresh_token: tokens.refresh_token, extra: true }]) {
    await request(app.getHttpServer()).post('/api/v1/auth/refresh_token').send(body).expect(400);
  }
  await refresh('A'.repeat(43)).expect(401);
});

test('current user rejects missing, malformed, tampered and refresh credentials', async () => {
  const tokens = await register();
  await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', 'Basic abc').expect(401);
  await me('invalid').expect(401);
  const parts = tokens.access_token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: randomUUID() })).toString('base64url');
  await me(parts.join('.')).expect(401);
  await me(tokens.refresh_token).expect(401);
});

test('current user rejects an expired access token while refresh still works', async (context) => {
  const tokens = await register();
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() + 16 * 60 * 1000 });
  try {
    await me(tokens.access_token).expect(401);
    const rotated = await refresh(tokens.refresh_token).expect(200);
    await me(rotated.body.access_token).expect(200);
  } finally { context.mock.timers.reset(); }
});

test('refresh sessions expire after seven days without extending on rotation', async (context) => {
  const tokens = await register();
  const started = Date.now();
  context.mock.timers.enable({ apis: ['Date'], now: started + 6 * 24 * 60 * 60 * 1000 });
  try {
    const rotated = await refresh(tokens.refresh_token).expect(200);
    context.mock.timers.setTime(started + 8 * 24 * 60 * 60 * 1000);
    await refresh(rotated.body.refresh_token).expect(401);
    await me(rotated.body.access_token).expect(401);
  } finally { context.mock.timers.reset(); }
});

test('JWTs with wrong issuer, audience or token purpose are rejected', async () => {
  const first = await register();
  const jwt = app.get(JwtService);
  const original = jwt.decode<Record<string, unknown>>(first.access_token);
  for (const overrides of [{ iss: 'other' }, { aud: 'other' }, { type: 'refresh' }, { sid: randomUUID() }, { sub: randomUUID() }]) {
    const token = jwt.sign({ ...original, ...overrides }, { secret: process.env.AUTH_ACCESS_TOKEN_SECRET });
    await me(token).expect(401);
  }
  const withoutExpiry = { ...original };
  delete withoutExpiry.exp;
  await me(jwt.sign(withoutExpiry, { secret: process.env.AUTH_ACCESS_TOKEN_SECRET })).expect(401);
  await me(jwt.sign(original, {
    secret: process.env.AUTH_ACCESS_TOKEN_SECRET,
    algorithm: 'HS512',
  })).expect(401);
});

test('logout revokes access and refresh tokens only for the authenticated session', async () => {
  const input = credentials();
  const first = await register(input);
  const second = await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(200);
  const otherUser = await register();
  assert.notEqual(first.user.id, otherUser.user.id);
  await request(app.getHttpServer()).post('/api/v1/auth/logout')
    .auth(first.access_token, { type: 'bearer' }).expect(204);
  await me(first.access_token).expect(401);
  await refresh(first.refresh_token).expect(401);
  await me(second.body.access_token).expect(200);
  const meOther = await me(otherUser.access_token).expect(200);
  assert.deepEqual(meOther.body, otherUser.user);
});

test('logout requires a valid access token', async () => {
  await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(401);
});

test('cookies alone do not authenticate requests', async () => {
  const tokens = await register();
  await request(app.getHttpServer()).get('/api/v1/auth/me')
    .set('Cookie', `access_token=${tokens.access_token}; refresh_token=${tokens.refresh_token}`).expect(401);
});

test('auth endpoints reject untrusted browser origins and cross-site requests', async () => {
  for (const path of ['register', 'login', 'refresh_token', 'logout']) {
    await request(app.getHttpServer()).post(`/api/v1/auth/${path}`)
      .set('Origin', 'https://untrusted.example').send(credentials()).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/auth/${path}`)
      .set('Sec-Fetch-Site', 'cross-site').send(credentials()).expect(403);
  }
});

test('trusted browser origin and command-line requests are accepted', async () => {
  await request(app.getHttpServer()).post('/api/v1/auth/register')
    .set('Origin', origin).send(credentials()).expect(201);
  await register();
});

for (const path of ['register', 'login', 'refresh_token']) {
  test(`${path} is rate limited after ten requests in a minute`, async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await request(app.getHttpServer()).post(`/api/v1/auth/${path}`).send({}).expect(400);
    }
    await request(app.getHttpServer()).post(`/api/v1/auth/${path}`).send({}).expect(429);
  });
}
