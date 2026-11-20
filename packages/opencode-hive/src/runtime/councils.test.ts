import { describe, expect, it } from 'bun:test';
import { DEFAULT_COUNCIL_CONFIG } from 'hive-core';
import { COUNCIL_ROSTER_NOTICE, resolveCouncilRoster, type CouncilAgentDescriptor } from './councils.js';
import { COUNCIL_SEAT_BASES } from './role-policy.js';

const seat = (baseAgent: string, available = true, description = `${baseAgent} seat`): CouncilAgentDescriptor => ({ baseAgent, available, description });

describe('resolveCouncilRoster', () => {
  it('seats usable members in configuration order and reports every skip reason once per name', () => {
    const roster = resolveCouncilRoster({
      defaultGroup: 'review',
      groups: {
        review: { description: 'Review seats', members: ['missing', 'offline', 'example-template-seat', 'placeholder', 'worker', 'architect', 'reviewer', 'scout', 'reviewer', 'missing'] },
        other: { members: ['scout'] },
      },
    }, {
      reviewer: seat('code-reviewer'), scout: seat('scout-researcher'), offline: seat('code-reviewer', false),
      'example-template-seat': seat('scout-researcher'), placeholder: seat('plan-reviewer', true, 'Example template only: replace this'),
      worker: seat('forager-worker'), architect: seat('architect-planner'),
    });

    expect(roster).toEqual({
      notice: COUNCIL_ROSTER_NOTICE,
      councils: [{ name: 'review', description: 'Review seats' }, { name: 'other' }],
      selected: 'review',
      ok: true,
      members: [
        { name: 'reviewer', baseAgent: 'code-reviewer', description: 'code-reviewer seat' },
        { name: 'scout', baseAgent: 'scout-researcher', description: 'scout-researcher seat' },
      ],
      skipped: [
        { name: 'missing', reason: 'not_registered' },
        { name: 'offline', reason: 'not_available' },
        { name: 'example-template-seat', reason: 'example_template' },
        { name: 'placeholder', reason: 'example_template' },
        { name: 'worker', reason: 'ineligible_base' },
        { name: 'architect', reason: 'ineligible_base' },
        { name: 'reviewer', reason: 'duplicate' },
        { name: 'missing', reason: 'duplicate' },
      ],
    });
  });

  it('accepts every council seat base, including vulnerability-reviewer, and refuses Investigator and Forager derivatives', () => {
    expect([...COUNCIL_SEAT_BASES]).toEqual(['scout-researcher', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer']);
    const agents = Object.fromEntries([
      ...COUNCIL_SEAT_BASES.map((base) => [`${base}-seat`, seat(base)]),
      ['experiment-specialist', seat('forager-investigator')], ['forager-investigator', seat('forager-investigator')],
      ['forager-ui', seat('forager-worker')], ['hive-helper', seat('hive-helper')],
    ]);
    const roster = resolveCouncilRoster({ groups: { all: { members: Object.keys(agents) } } }, agents, 'all');
    expect(roster.ok && roster.members.map((member) => member.baseAgent)).toEqual([...COUNCIL_SEAT_BASES]);
    expect(roster.skipped).toEqual(['experiment-specialist', 'forager-investigator', 'forager-ui', 'hive-helper'].map((name) => ({ name, reason: 'ineligible_base' })));
  });

  it('fails an unknown or seatless council with no members and no fallback to another council', () => {
    const council = { defaultGroup: 'review', groups: { review: { members: ['reviewer'] }, empty: { members: ['offline', 'missing'] } } };
    const agents = { reviewer: seat('code-reviewer'), offline: seat('code-reviewer', false) };

    const unknown = resolveCouncilRoster(council, agents, 'absent');
    expect(unknown).toMatchObject({ selected: 'absent', ok: false, reason: 'unknown_council', skipped: [] });
    expect(unknown).not.toHaveProperty('members');

    const empty = resolveCouncilRoster(council, agents, 'empty');
    expect(empty).toMatchObject({ selected: 'empty', ok: false, reason: 'no_usable_seats', skipped: [{ name: 'offline', reason: 'not_available' }, { name: 'missing', reason: 'not_registered' }] });
    expect(empty).not.toHaveProperty('members');
    expect(JSON.stringify(empty)).not.toContain('"reviewer"');
  });

  it('fails only the default call when the default council is broken, and still resolves a named usable council', () => {
    const agents = { reviewer: seat('code-reviewer') };
    expect(resolveCouncilRoster({ defaultGroup: 'absent', groups: { review: { members: ['reviewer'] } } }, agents))
      .toMatchObject({ selected: 'absent', ok: false, reason: 'unknown_council' });
    expect(resolveCouncilRoster({ defaultGroup: 'absent', groups: { review: { members: ['reviewer'] } } }, agents, 'review'))
      .toMatchObject({ selected: 'review', ok: true, members: [{ name: 'reviewer' }] });
    expect(resolveCouncilRoster({ groups: { decision: { members: ['missing'] }, review: { members: ['reviewer'] } } }, agents))
      .toMatchObject({ selected: 'decision', ok: false, reason: 'no_usable_seats' });
    expect(resolveCouncilRoster({ groups: { review: { members: ['reviewer'] } } }, agents)).not.toHaveProperty('defaultCouncil');
  });

  it('looks up councils and agents by own key only', () => {
    const agents = { reviewer: seat('code-reviewer') };
    const council = { groups: { review: { members: ['toString', 'constructor', 'reviewer'] } } };
    expect(resolveCouncilRoster(council, agents, 'review').skipped).toEqual([{ name: 'toString', reason: 'not_registered' }, { name: 'constructor', reason: 'not_registered' }]);
    expect(resolveCouncilRoster(council, agents, 'toString')).toMatchObject({ ok: false, reason: 'unknown_council' });
  });

  it('resolves the built-in councils to their stock read-only rosters', () => {
    const agents = Object.fromEntries(COUNCIL_SEAT_BASES.map((base) => [base, seat(base)]));
    expect(Object.fromEntries(Object.keys(DEFAULT_COUNCIL_CONFIG.groups!).map((name) => {
      const roster = resolveCouncilRoster(DEFAULT_COUNCIL_CONFIG, agents, name);
      return [name, roster.ok ? roster.members.map((member) => member.name) : roster.reason];
    }))).toEqual({
      design: ['scout-researcher', 'approach-advisor', 'plan-reviewer', 'code-reviewer'],
      decision: ['scout-researcher', 'approach-advisor', 'plan-reviewer'],
      'minimal-change': ['scout-researcher', 'simplicity-reviewer', 'code-reviewer'],
      documents: ['scout-researcher', 'code-reviewer', 'plan-reviewer'],
    });
  });
});
