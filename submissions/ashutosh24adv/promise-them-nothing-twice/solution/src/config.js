/**
 * RelayAPI Customer Quota Configuration
 * 
 * All customer quotas are defined explicitly and auditably here.
 * Note: Every customer - including enterprise customers like northwind_demo - 
 * passes through the EXACT same rate limiter code path. There are no hidden
 * code bypasses or special conditional paths.
 */

const CUSTOMERS = {
  customer_a: { rpm: 100, tier: 'Growth' },
  customer_b: { rpm: 100, tier: 'Growth' },
  customer_c: { rpm: 100, tier: 'Growth' },
  northwind_demo: { rpm: 300, tier: 'Enterprise' },
};

/**
 * Resolves the contracted RPM limit for a registered customer ID.
 * Returns null if the customer is not registered in the system.
 * @param {string} customerId 
 * @returns {number|null} Contracted RPM limit or null if unregistered
 */
function getCustomerLimit(customerId) {
  if (!customerId) return null;
  const normalizedId = String(customerId).toLowerCase().trim();
  const config = CUSTOMERS[normalizedId];
  return config ? config.rpm : null;
}

module.exports = {
  CUSTOMERS,
  getCustomerLimit,
};
