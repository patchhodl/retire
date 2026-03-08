/**
 * Patchhodl Ontario Retirement Planner - browser version
 * Tax calculator (2026 Federal + Ontario), retirement engine, and UI.
 */

// ----- Tax Calculator (2026 Federal + Ontario) -----
const TaxCalculator = {
  federalBrackets: [
    [58523, 0.14],
    [117045, 0.205],
    [181440, 0.26],
    [258482, 0.29],
    [Infinity, 0.33]
  ],
  federalBPA: 16452,
  ontarioBrackets: [
    [53891, 0.0505],
    [107785, 0.0915],
    [150000, 0.1116],
    [220000, 0.1216],
    [Infinity, 0.1316]
  ],
  ontarioBPA: 12989,
  ontarioSurtax20: 5818,
  ontarioSurtax36: 7446,
  oasClawbackThreshold: 95323,

  computeProgressiveTax(income, brackets) {
    let tax = 0, lastLimit = 0;
    for (const [limit, rate] of brackets) {
      const band = Math.min(income, limit) - lastLimit;
      if (band > 0) {
        tax += band * rate;
        lastLimit = limit;
      } else break;
    }
    return tax;
  },

  computeTotalTax(taxableIncome, age) {
    if (taxableIncome <= 0) return 0;
    let federal = this.computeProgressiveTax(taxableIncome, this.federalBrackets);
    let ontario = this.computeProgressiveTax(taxableIncome, this.ontarioBrackets);
    const federalCredit = this.federalBrackets[0][1] * this.federalBPA;
    const ontarioCredit = this.ontarioBrackets[0][1] * this.ontarioBPA;
    federal = Math.max(0, federal - federalCredit);
    ontario = Math.max(0, ontario - ontarioCredit);
    let surtax = 0;
    if (ontario > this.ontarioSurtax20) surtax += 0.20 * (ontario - this.ontarioSurtax20);
    if (ontario > this.ontarioSurtax36) surtax += 0.36 * (ontario - this.ontarioSurtax36);
    ontario += surtax;
    return Math.max(0, federal + ontario);
  },

  computeOasClawback(taxableIncome, annualOas) {
    if (annualOas <= 0 || taxableIncome <= this.oasClawbackThreshold) return 0;
    const recovery = 0.15 * (taxableIncome - this.oasClawbackThreshold);
    return Math.min(Math.max(0, recovery), annualOas);
  }
};

// ----- Retirement Engine -----
const MaxCppMonthlyAt65 = 1507.65;
const CppFactorAt60 = 0.64;
const CppFactorAt70 = 1.42;
const MaxOasMonthly65to74 = 742.31;

function rrifFactor(age) {
  if (age < 71) return 0;
  const capped = Math.min(age, 94);
  return 1 / (90 - capped);
}

function solveTaxableWithdrawals(ageH, ageW, cppTotal, oasTotal, pensionTotal, netNeed, taxablePool) {
  let low = 0, high = taxablePool;
  let bestWithdrawals = 0, bestTaxes = 0, bestNetFromTaxable = 0;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    const familyTaxableIncome = cppTotal + oasTotal + pensionTotal + mid;
    const incomeH = familyTaxableIncome / 2, incomeW = familyTaxableIncome / 2;
    const annualOasPerSpouse = oasTotal / 2;
    const taxH = TaxCalculator.computeTotalTax(incomeH, ageH);
    const taxW = TaxCalculator.computeTotalTax(incomeW, ageW);
    const clawH = TaxCalculator.computeOasClawback(incomeH, annualOasPerSpouse);
    const clawW = TaxCalculator.computeOasClawback(incomeW, annualOasPerSpouse);
    const totalTax = taxH + taxW + clawH + clawW;
    const netTotal = familyTaxableIncome - totalTax;
    if (netTotal >= netNeed || Math.abs(high - low) < 1) {
      bestWithdrawals = mid;
      bestTaxes = totalTax;
      bestNetFromTaxable = netTotal - cppTotal - oasTotal;
      high = mid;
    } else {
      low = mid;
    }
  }
  return { withdrawals: bestWithdrawals, taxes: bestTaxes, netFromTaxable: bestNetFromTaxable };
}

function computeTaxAndNetFromWithdrawal(ageH, ageW, cppTotal, oasTotal, pensionTotal, taxableWithdrawals) {
  const familyTaxableIncome = cppTotal + oasTotal + pensionTotal + taxableWithdrawals;
  const incomeH = familyTaxableIncome / 2, incomeW = familyTaxableIncome / 2;
  const annualOasPerSpouse = oasTotal / 2;
  const taxH = TaxCalculator.computeTotalTax(incomeH, ageH);
  const taxW = TaxCalculator.computeTotalTax(incomeW, ageW);
  const clawH = TaxCalculator.computeOasClawback(incomeH, annualOasPerSpouse);
  const clawW = TaxCalculator.computeOasClawback(incomeW, annualOasPerSpouse);
  const totalTax = taxH + taxW + clawH + clawW;
  const netTotal = familyTaxableIncome - totalTax;
  return { totalTax, netFromTaxable: netTotal - cppTotal - oasTotal };
}

function runEngine(params) {
  const {
    rrspH, rrspW, tfsaH, tfsaW, liraH, liraW,
    incomeH, incomeW, pensionH, pensionW,
    growth, inflation, pensionRate = 0.04, cppOasRate = 0.02, cppStartAge, retireAgeH, retireAgeW, endAge,
    currentAgeH, currentAgeW
  } = params;

  const results = [];
  let rH = rrspH, rW = rrspW, tH = tfsaH, tW = tfsaW;
  let lH = liraH, lW = liraW, fH = 0, fW = 0; // LIF

  const years = endAge - Math.min(currentAgeH, currentAgeW);
  const cppAge = [60, 65, 70].includes(cppStartAge) ? cppStartAge : 65;
  const cppFactor = cppAge === 60 ? CppFactorAt60 : (cppAge === 70 ? CppFactorAt70 : 1);

  for (let yearIndex = 0; yearIndex <= years; yearIndex++) {
    const ageH = currentAgeH + yearIndex;
    const ageW = currentAgeW + yearIndex;

    if (ageH < retireAgeH && ageW < retireAgeW) {
      const g = 1 + growth;
      rH *= g; rW *= g; tH *= g; tW *= g; lH *= g; fH *= g; lW *= g; fW *= g;
      continue;
    }

    const needH = incomeH * Math.pow(1 + inflation, yearIndex);
    const needW = incomeW * Math.pow(1 + inflation, yearIndex);
    const netNeed = needH + needW;

    const cppOasGrowth = Math.pow(1 + cppOasRate, yearIndex);
    const cppH = ageH >= cppAge ? MaxCppMonthlyAt65 * 12 * cppFactor * cppOasGrowth : 0;
    const cppW = ageW >= cppAge ? MaxCppMonthlyAt65 * 12 * cppFactor * cppOasGrowth : 0;
    const oasH = ageH >= 65 ? MaxOasMonthly65to74 * 12 * cppOasGrowth : 0;
    const oasW = ageW >= 65 ? MaxOasMonthly65to74 * 12 * cppOasGrowth : 0;
    const pH = pensionH * Math.pow(1 + pensionRate, yearIndex);
    const pW = pensionW * Math.pow(1 + pensionRate, yearIndex);
    const cppTotal = cppH + cppW, oasTotal = oasH + oasW, pensionTotal = pH + pW;

    if (ageH >= 55 && lH > 0) { fH += lH; lH = 0; }
    if (ageW >= 55 && lW > 0) { fW += lW; lW = 0; }

    let rrifLifMin = 0;
    if (ageH >= 71) rrifLifMin += rrifFactor(ageH) * (rH + fH);
    if (ageW >= 71) rrifLifMin += rrifFactor(ageW) * (rW + fW);

    const taxablePool = rH + rW + fH + fW;
    let { withdrawals: taxableWithdrawals, taxes, netFromTaxable } = solveTaxableWithdrawals(
      ageH, ageW, cppTotal, oasTotal, pensionTotal, netNeed, taxablePool);

    if ((ageH >= 71 || ageW >= 71) && taxablePool > 0) {
      const minRequired = Math.min(rrifLifMin, taxablePool);
      if (taxableWithdrawals < minRequired) {
        taxableWithdrawals = minRequired;
        const out = computeTaxAndNetFromWithdrawal(ageH, ageW, cppTotal, oasTotal, pensionTotal, taxableWithdrawals);
        taxes = out.totalTax;
        netFromTaxable = out.netFromTaxable;
      }
    }

    const netFromTaxablePlusPensions = cppTotal + oasTotal + netFromTaxable;
    const sharedNet = netFromTaxablePlusPensions - pensionTotal;
    const hNonTfsa = pH + 0.5 * sharedNet;
    const wNonTfsa = pW + 0.5 * sharedNet;
    const shortfallH = Math.max(0, needH - hNonTfsa);
    const shortfallW = Math.max(0, needW - wNonTfsa);

    if (taxableWithdrawals > 0 && taxablePool > 0) {
      const fromHrrsp = taxableWithdrawals * (rH / taxablePool);
      const fromWrrsp = taxableWithdrawals * (rW / taxablePool);
      const fromLifH = taxableWithdrawals * (fH / taxablePool);
      const fromLifW = taxableWithdrawals * (fW / taxablePool);
      rH = Math.max(0, rH - fromHrrsp);
      rW = Math.max(0, rW - fromWrrsp);
      fH = Math.max(0, fH - fromLifH);
      fW = Math.max(0, fW - fromLifW);
    }

    let tfsaWithdrawals = 0;
    if (shortfallH > 0) {
      const fromH = Math.min(shortfallH, tH);
      tH -= fromH;
      tfsaWithdrawals += fromH;
      const remainH = shortfallH - fromH;
      if (remainH > 0) {
        const fromW = Math.min(remainH, tW);
        tW -= fromW;
        tfsaWithdrawals += fromW;
      }
    }
    if (shortfallW > 0) {
      const fromW = Math.min(shortfallW, tW);
      tW -= fromW;
      tfsaWithdrawals += fromW;
      const remainW = shortfallW - fromW;
      if (remainW > 0) {
        const fromH = Math.min(remainW, tH);
        tH -= fromH;
        tfsaWithdrawals += fromH;
      }
    }

    // If pension (and other income) exceeds desired income after tax, contribute surplus to TFSA
    const familyTaxableIncome = cppTotal + oasTotal + pensionTotal + taxableWithdrawals;
    const netTotal = familyTaxableIncome - taxes;
    const hNet = netTotal / 2;
    const wNet = netTotal / 2;
    if (hNet > needH) tH += hNet - needH;
    if (wNet > needW) tW += wNet - needW;

    const totalWithdrawals = taxableWithdrawals + tfsaWithdrawals + cppTotal + oasTotal + pensionTotal;
    const g = 1 + growth;
    rH *= g; rW *= g; tH *= g; tW *= g; lH *= g; fH *= g; lW *= g; fW *= g;

    results.push({
      yearIndex, ageH, ageW,
      rrspH: rH, rrspW: rW, liraH: lH, liraW: lW, lifH: fH, lifW: fW, tfsaH: tH, tfsaW: tW,
      cppTotal, oasTotal, pensionH: pH, pensionW: pW, pensionTotal,
      rrifLifMinimum: rrifLifMin,
      totalWithdrawals, taxes,
      netIncome: Math.min(netNeed, netFromTaxablePlusPensions + tfsaWithdrawals),
      endingBalances: rH + rW + tH + tW + lH + lW + fH + fW
    });
  }
  return results;
}
