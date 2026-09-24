import { describe, expect, it } from 'vitest';
import { isChocolatey, isFruity } from '@/lib/suggest/flavor';

// Owner addition: 'chocolatey'/'fruity' step-1 extras (soft preferences —
// lib/suggest/score.ts's extras term, never a hard filter).

describe('isChocolatey', () => {
  it('matches by name', () => {
    expect(isChocolatey('Signature Hot Chocolate', [])).toBe(true);
    expect(isChocolatey('Nutella Waffle', [])).toBe(true);
    expect(isChocolatey('Oreo Milkshake', [])).toBe(true);
    expect(isChocolatey('Kit-Kat Frappe', [])).toBe(true);
    expect(isChocolatey('Double Fudge Brownie', [])).toBe(true);
    expect(isChocolatey('Chocolate Truffle Cake', [])).toBe(true);
  });

  it('matches by flavor note when the name gives no hint', () => {
    expect(isChocolatey('Mocha', ['chocolate', 'coffee-forward'])).toBe(true);
    expect(isChocolatey('Signature Blend', ['cocoa', 'nutty'])).toBe(true);
  });

  it('does not match an unrelated item', () => {
    expect(isChocolatey('Berry Lemonade Iced', ['berry', 'citrus'])).toBe(false);
    expect(isChocolatey('Espresso', ['bold', 'nutty'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isChocolatey('CHOCOLATE FUDGE CAKE', [])).toBe(true);
  });
});

describe('isFruity', () => {
  it('matches by name', () => {
    expect(isFruity('Fruity Strawberry Creme', [])).toBe(true);
    expect(isFruity('Berry Lemonade Iced', [])).toBe(true);
    expect(isFruity('Mango Cooler', [])).toBe(true);
    expect(isFruity('Passionfruit Iced Tea', [])).toBe(true);
    expect(isFruity('Watermelon Cooler', [])).toBe(true);
  });

  it('matches by flavor note when the name gives no hint', () => {
    expect(isFruity('Signature Cooler', ['citrus', 'zesty'])).toBe(true);
    expect(isFruity('House Special', ['blueberry'])).toBe(true);
  });

  it('does not match an unrelated item', () => {
    expect(isFruity('Signature Hot Chocolate', ['chocolate'])).toBe(false);
    expect(isFruity('Espresso', ['bold', 'nutty'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isFruity('STRAWBERRY SMOOTHIE', [])).toBe(true);
  });
});
