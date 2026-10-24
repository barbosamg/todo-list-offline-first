import { describe, expect, it } from 'vitest';
import cases from '../../../../shared/urgent-rule-cases.json';
import { isUrgent } from './urgent-rule';

describe('regra de tarefas urgentes', () => {
  // Os mesmos vetores rodam no backend (UrgentRuleTests.cs): paridade entre online e offline.
  it.each(cases)('$name', ({ title, description, urgent }) => {
    expect(isUrgent(title, description)).toBe(urgent);
  });

  it('aceita null/undefined', () => {
    expect(isUrgent(null, undefined)).toBe(false);
  });
});
