#!/usr/bin/env node

/**
 * RelayAPI Rate Limiter Verification Load Harness
 * 
 * Drives high-concurrency requests through the Load Balancer (http://localhost:8080)
 * to verify distributed rate limiting, customer isolation, hard boundary cutoff,
 * Retry-After header validity, and cross-node distribution.
 */

const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const parsedUrl = new URL(BASE_URL);

/**
 * Helper to send a single HTTP GET request.
 */
function sendRequest(customerId, endpoint = '/api/v1/ping') {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: endpoint,
        method: 'GET',
        headers: {
          'X-Customer-Id': customerId,
          'Connection': 'keep-alive',
        },
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

/**
 * Sends N concurrent requests in parallel batches.
 */
async function sendBatch(customerId, count, batchConcurrency = 50) {
  const results = [];
  const tasks = Array.from({ length: count }, () => () => sendRequest(customerId));

  // Run in chunks with controlled concurrency to prevent socket exhaustion
  for (let i = 0; i < tasks.length; i += batchConcurrency) {
    const chunk = tasks.slice(i, i + batchConcurrency);
    const chunkResults = await Promise.all(chunk.map((fn) => fn()));
    results.push(...chunkResults);
  }

  return results;
}

/**
 * Checks health of the load balancer and backend nodes.
 */
async function checkHealth(maxAttempts = 10, delayMs = 1500) {
  console.log(`[Harness] Verifying connection to Load Balancer at ${BASE_URL}...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await sendRequest('health_check', '/health');
    if (res.status === 200 && res.body && res.body.status === 'healthy') {
      console.log(`[Harness] Load Balancer healthy (served by ${res.body.node}).\n`);
      return true;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`[Harness] Could not reach healthy backend at ${BASE_URL} after ${maxAttempts} attempts.`);
}

/**
 * Synchronizes execution with a clean UTC minute window to avoid boundary rollover.
 */
async function syncToCleanMinuteWindow(minBufferSeconds = 15) {
  const now = new Date();
  const secondsIntoMinute = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  const remainingSeconds = 60 - secondsIntoMinute;

  if (remainingSeconds < minBufferSeconds) {
    const waitMs = Math.ceil(remainingSeconds * 1000) + 200;
    console.log(`[Harness] Only ${remainingSeconds.toFixed(1)}s left in current UTC minute window.`);
    console.log(`[Harness] Waiting ${(waitMs / 1000).toFixed(1)}s for next UTC minute to ensure test runs inside a single window...`);
    await new Promise((r) => setTimeout(r, waitMs));
    console.log(`[Harness] Synchronized to fresh minute window: ${new Date().toISOString()}\n`);
  } else {
    console.log(`[Harness] Current UTC minute has ${remainingSeconds.toFixed(1)}s remaining. Safe to execute test bursts.\n`);
  }
}

/**
 * Formats results into a clean ASCII table.
 */
function printResultsTable(rows) {
  console.log('\n============================= HARNESS RESULTS =============================');
  const headers = ['Scenario / Customer', 'Sent', '200 OK', '429 Limit', '5xx / Err', 'Status'];
  const colWidths = [22, 8, 10, 12, 12, 10];

  const formatRow = (cols) =>
    cols.map((col, i) => String(col).padEnd(colWidths[i])).join(' | ');

  console.log(formatRow(headers));
  console.log(colWidths.map((w) => '-'.repeat(w)).join('-+-'));

  for (const r of rows) {
    console.log(
      formatRow([
        r.name,
        r.sent,
        r.count200,
        r.count429,
        r.countOther,
        r.passed ? 'PASS' : 'FAIL',
      ])
    );
  }
  console.log('===========================================================================\n');
}

async function run() {
  console.log('===========================================================================');
  console.log('       RELAYAPI DISTRIBUTED RATE LIMITER LOAD HARNESS                      ');
  console.log('===========================================================================\n');

  try {
    await checkHealth();
    await syncToCleanMinuteWindow(20);

    const reportRows = [];
    let allPassed = true;
    const nodeDistribution = {};

    const trackNodes = (results) => {
      for (const res of results) {
        if (res.body && res.body.node) {
          nodeDistribution[res.body.node] = (nodeDistribution[res.body.node] || 0) + 1;
        }
      }
    };

    // Scenario A: Customer Isolation (customer_a, limit 100)
    console.log('[Scenario A] Sending 100 concurrent requests for customer_a (Limit: 100)...');
    const resA = await sendBatch('customer_a', 100);
    trackNodes(resA);
    const count200A = resA.filter((r) => r.status === 200).length;
    const count429A = resA.filter((r) => r.status === 429).length;
    const countOtherA = resA.length - count200A - count429A;
    const passA = count200A === 100 && count429A === 0 && countOtherA === 0;
    if (!passA) allPassed = false;
    reportRows.push({
      name: 'customer_a (100 RPM)',
      sent: 100,
      count200: count200A,
      count429: count429A,
      countOther: countOtherA,
      passed: passA,
    });

    // Scenario B: Same-Tier Fairness (customer_b, limit 100)
    console.log('[Scenario B] Sending 100 concurrent requests for customer_b (Limit: 100)...');
    const resB = await sendBatch('customer_b', 100);
    trackNodes(resB);
    const count200B = resB.filter((r) => r.status === 200).length;
    const count429B = resB.filter((r) => r.status === 429).length;
    const countOtherB = resB.length - count200B - count429B;
    const passB = count200B === 100 && count429B === 0 && countOtherB === 0;
    if (!passB) allPassed = false;
    reportRows.push({
      name: 'customer_b (100 RPM)',
      sent: 100,
      count200: count200B,
      count429: count429B,
      countOther: countOtherB,
      passed: passB,
    });

    // Scenario C: Hard Boundary Enforcement (customer_c, limit 100, 130 requests sent)
    console.log('[Scenario C] Sending 130 concurrent requests for customer_c (Limit: 100, Burst: 130)...');
    const resC = await sendBatch('customer_c', 130);
    trackNodes(resC);
    const count200C = resC.filter((r) => r.status === 200).length;
    const count429C = resC.filter((r) => r.status === 429).length;
    const countOtherC = resC.length - count200C - count429C;

    // Validate 429 Retry-After headers
    const rejectedC = resC.filter((r) => r.status === 429);
    const validRetryHeaders = rejectedC.every(
      (r) => r.retryAfter && parseInt(r.retryAfter, 10) >= 1 && parseInt(r.retryAfter, 10) <= 60
    );

    const passC = count200C === 100 && count429C === 30 && countOtherC === 0 && validRetryHeaders;
    if (!passC) allPassed = false;
    reportRows.push({
      name: 'customer_c (100 RPM)',
      sent: 130,
      count200: count200C,
      count429: count429C,
      countOther: countOtherC,
      passed: passC,
    });

    printResultsTable(reportRows);

    console.log('Multi-Node Distribution Breakdown:');
    console.table(nodeDistribution);

    const nodesHit = Object.keys(nodeDistribution).length;
    console.log(`Total active nodes handling traffic: ${nodesHit}`);

    if (rejectedC.length > 0) {
      console.log(`Sample 429 Response Header: Retry-After = ${rejectedC[0].retryAfter}s`);
      console.log(`Sample 429 Response Body:`, JSON.stringify(rejectedC[0].body));
    }

    if (!validRetryHeaders && rejectedC.length > 0) {
      console.error('FAIL: Some 429 responses were missing a valid Retry-After header!');
    }

    if (allPassed) {
      console.log('\n>>> ALL HARNESS ASSERTIONS PASSED SUCCESSFULLY (Exit Code 0) <<<\n');
      process.exit(0);
    } else {
      console.error('\n>>> HARNESS ASSERTIONS FAILED (Exit Code 1) <<<\n');
      process.exit(1);
    }
  } catch (err) {
    console.error('\n[Harness Fatal Error]', err.message);
    process.exit(1);
  }
}

run();
