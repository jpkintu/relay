import { describe, expect, test } from 'vitest';
import { restaurantAddress, subdomainCode } from './restaurant';

describe('restaurant addresses', () => {
  test('a restaurant subdomain gives its code', () => {
    expect(subdomainCode('relayeats.app', 'aldea.relayeats.app')).toBe('aldea');
    expect(subdomainCode('relayeats.app', 'Mama-Rose.RelayEats.app')).toBe('mama-rose');
  });

  test('the main domain, other hosts and reserved names give none', () => {
    expect(subdomainCode('relayeats.app', 'relayeats.app')).toBe('');
    expect(subdomainCode('relayeats.app', 'www.relayeats.app')).toBe('');
    expect(subdomainCode('relayeats.app', 'a.b.relayeats.app')).toBe('');
    expect(subdomainCode('relayeats.app', 'aldea.example.com')).toBe('');
    expect(subdomainCode('', 'aldea.relayeats.app')).toBe('');
    expect(subdomainCode('relayeats.app', 'ab.relayeats.app')).toBe('');
  });

  test('addresses read as subdomains once the domain is set', () => {
    expect(restaurantAddress('aldea', 'relayeats.app')).toBe('aldea.relayeats.app');
    expect(restaurantAddress('aldea', '')).toBe('/r/aldea');
  });
});
