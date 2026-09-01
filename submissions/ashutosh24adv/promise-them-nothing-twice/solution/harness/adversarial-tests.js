#!/usr/bin/env node

/**
 * Adversarial and Edge-Case Test Suite for RelayAPI Rate Limiter
 * 
 * Verifies:
 * 1. Off-by-one boundary (101 requests -> exactly 100 200s, 1 429)
 * 2. High-concurrency stress (300 requests -> exactly 100 200s, 200 429s)
 * 3. Simultaneous parallel multi-tenant bursts (CustA 130 + CustB 130)
 * 4. Missing X-Customer-Id header -> returns 400 Bad Request
 * 5. Unknown / unconfigured customer ID -> returns 400 Bad Request
 * 6. Northwind demo (Limit 300 -> 350 requests -> 300 200s, 50 429s)
 */

const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const parsedUrl = new URL(BASE_URL);

function sendRequest(customerId, endpoint = '/api/v1/ping') {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const headers = { 'Connection': 'keep-alive' };
    if (customerId !== null) {
      headers['X-Customer-Id'] = customerId;
    }

    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: endpoint,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (e) {
            json = { raw: body };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            retryAfter: res.headers['retry-after'],
            body: json,
            latencyMs: Date.now() - startTime,
          });
        });
      }
    );

    req.on('error', (err) => {
      resolve({
        status: 0,
        error: err.message,
        latencyMs: Date.now() - startTime,
      });
    });

    req.end();
  });
}

async function sendBatch(customerId, count, concurrency = 60) {
  const results = [];
  const tasks = Array.from({ length: count }, () => () => sendRequest(customerId));

  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map((fn) => fn()));
    results.push(...chunkResults);
  }

  return results;
}

async function syncToFreshMinute(minBuffer = 20) {
  const now = new Date();
  const secondsIntoMinute = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  const remaining = 60 - secondsIntoMinute;

  if (remaining < minBuffer) {
    const waitMs = Math.ceil(remaining * 1000) + 200;
    console.log(`[Adversarial] Waiting ${(waitMs / 1000).toFixed(1)}s for next UTC minute window...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function runAdversarialTests() {
  console.log('===========================================================================');
  console.log('            ADVERSARIAL & EDGE-CASE TEST SUITE                             ');
  console.log('===========================================================================\n');

  await syncToFreshMinute(25);

  let passed = true;

  // Test 1: Off-by-one boundary (101 requests for customer_a, Limit 100)
  console.log('Test 1: Off-By-One Boundary (101 requests for customer_a, Limit 100)...');
  const res1 = await sendBatch('customer_a', 101);
  const count200_1 = res1.filter((r) => r.status === 200).length;
  const count429_1 = res1.filter((r) => r.status === 429).length;
  console.log(`Result 1: 200 OK: ${count200_1}, 429 Limit: ${count429_1}`);
  if (count200_1 !== 100 || count429_1 !== 1) {
    console.error('FAIL Test 1: Expected exactly 100 200s and 1 429!');
    passed = false;
  } else {
    console.log('PASS Test 1: Exactly 100 admitted, 1 rejected.');
  }

  // Test 2: High Concurrency Stress Test (300 requests for customer_b, Limit 100)
  console.log('\nTest 2: High Concurrency Burst (300 concurrent requests for customer_b, Limit 100)...');
  const res2 = await sendBatch('customer_b', 300, 100);
  const count200_2 = res2.filter((r) => r.status === 200).length;
  const count429_2 = res2.filter((r) => r.status === 429).length;
  console.log(`Result 2: 200 OK: ${count200_2}, 429 Limit: ${count429_2}`);
  if (count200_2 !== 100 || count429_2 !== 200) {
    console.error('FAIL Test 2: Expected exactly 100 200s and 200 429s!');
    passed = false;
  } else {
    console.log('PASS Test 2: Exactly 100 admitted, 200 rejected without counter leaks.');
  }

  // Test 3: Simultaneous Parallel Multi-Tenant Bursts
  console.log('\nTest 3: Simultaneous Parallel Multi-Tenant Bursts (customer_c [130] vs northwind_demo [350])...');
  const [resC, resNW] = await Promise.all([
    sendBatch('customer_c', 130, 65),
    sendBatch('northwind_demo', 350, 70),
  ]);

  const count200_C = resC.filter((r) => r.status === 200).length;
  const count429_C = resC.filter((r) => r.status === 429).length;
  const count200_NW = resNW.filter((r) => r.status === 200).length;
  const count429_NW = resNW.filter((r) => r.status === 429).length;

  console.log(`Customer C (Limit 100, Sent 130) -> 200 OK: ${count200_C}, 429 Limit: ${count429_C}`);
  console.log(`Northwind Demo (Limit 300, Sent 350) -> 200 OK: ${count200_NW}, 429 Limit: ${count429_NW}`);

  if (count200_C !== 100 || count429_C !== 30 || count200_NW !== 300 || count429_NW !== 50) {
    console.error('FAIL Test 3: Quota isolation failure under parallel multi-tenant load!');
    passed = false;
  } else {
    console.log('PASS Test 3: Isolation held perfectly under parallel multi-tenant load.');
  }

  // Test 4: Missing X-Customer-Id Header -> must return 400 Bad Request
  console.log('\nTest 4: Missing X-Customer-Id Header (Expected: 400 Bad Request)...');
  const resMissing = await sendRequest(null);
  console.log(`Missing Header -> Status: ${resMissing.status}, Body: ${JSON.stringify(resMissing.body)}`);
  if (resMissing.status !== 400 || !resMissing.body || !resMissing.body.error) {
    console.error('FAIL Test 4: Expected HTTP 400 Bad Request for missing X-Customer-Id header!');
    passed = false;
  } else {
    console.log('PASS Test 4: Missing header correctly rejected with 400 Bad Request.');
  }

  // Test 5: Unknown / Unregistered Customer ID -> must return 400 Bad Request
  console.log('\nTest 5: Unknown Customer ID (Expected: 400 Bad Request)...');
  const resUnknown = await sendRequest('unregistered_rogue_client');
  console.log(`Unknown Customer -> Status: ${resUnknown.status}, Body: ${JSON.stringify(resUnknown.body)}`);
  if (resUnknown.status !== 400 || !resUnknown.body || !resUnknown.body.error) {
    console.error('FAIL Test 5: Expected HTTP 400 Bad Request for unknown customer ID!');
    passed = false;
  } else {
    console.log('PASS Test 5: Unknown customer ID correctly rejected with 400 Bad Request.');
  }

  console.log('\n===========================================================================');
  if (passed) {
    console.log('>>> ALL ADVERSARIAL TESTS PASSED PERFECTLY (Exit Code 0) <<<');
    process.exit(0);
  } else {
    console.error('>>> ADVERSARIAL TESTS FAILED (Exit Code 1) <<<');
    process.exit(1);
  }
}

runAdversarialTests();
