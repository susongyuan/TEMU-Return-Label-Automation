function normalizeOrderNo(input) {
  const raw = String(input || '').trim().replace(/\s+/g, '');
  if (!raw) return '';
  const withoutPrefix = raw.replace(/^ST-/i, '');
  const withoutSplitSuffix = withoutPrefix.replace(/-D\d{2}$/i, '');
  return `ST-${withoutSplitSuffix}`;
}

function splitOrderInput(input) {
  return String(input || '')
    .split(/[\r\n]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function normalizeReturnMode(mode, trackingNo, carrierName) {
  const explicit = String(mode || '').trim().toLowerCase();
  if (['custom', 'self', 'manual', '自选', '自寄'].includes(explicit)) return 'custom';
  if (['auto', 'platform', 'official', '平台', '官方', '代选'].includes(explicit)) return 'auto';
  return trackingNo || carrierName ? 'custom' : 'auto';
}

function parseOrderLine(line) {
  if (line && typeof line === 'object') {
    const rawOrderNo = line.rawOrderNo || line.raw || line.poOrderNo || line.poNo || line.orderNo || line.input || line.stOrderNo || '';
    const customerReturnTrackingNo = line.customerReturnTrackingNo ||
      line.returnTrackingNo ||
      line.returnExpressNo ||
      line.expressNo ||
      '';
    const customerReturnCarrierName = line.customerReturnCarrierName ||
      line.returnCarrierName ||
      line.returnCourier ||
      line.courier ||
      line.supplierName ||
      line.returnSupplierName ||
      '';
    const preferredReturnCourier = line.preferredReturnCourier ||
      line.preferredCourier ||
      line.preferredLogistics ||
      customerReturnCarrierName ||
      '';
    const returnLogisticsMode = normalizeReturnMode(line.returnLogisticsMode || line.logisticsMode, customerReturnTrackingNo, customerReturnCarrierName);
    return {
      ...line,
      rawOrderNo,
      stOrderNo: line.stOrderNo || normalizeOrderNo(rawOrderNo),
      customerReturnTrackingNo,
      returnExpressNo: customerReturnTrackingNo,
      customerReturnCarrierName,
      preferredReturnCourier,
      returnCourier: customerReturnCarrierName,
      supplierName: customerReturnCarrierName,
      returnSupplierName: customerReturnCarrierName,
      returnLogisticsMode
    };
  }
  const text = String(line || '').trim();
  const parts = text.split(/[,，\t ]+/).map(value => value.trim()).filter(Boolean);
  const rawOrderNo = parts[0] || '';
  const customerReturnTrackingNo = parts[1] || '';
  const customerReturnCarrierName = parts.slice(2).join(' ');
  const returnLogisticsMode = normalizeReturnMode('', customerReturnTrackingNo, customerReturnCarrierName);
  return {
    rawOrderNo,
    stOrderNo: normalizeOrderNo(rawOrderNo),
    customerReturnTrackingNo,
    returnExpressNo: customerReturnTrackingNo,
    customerReturnCarrierName,
    preferredReturnCourier: customerReturnCarrierName,
    returnCourier: customerReturnCarrierName,
    supplierName: customerReturnCarrierName,
    returnSupplierName: customerReturnCarrierName,
    returnLogisticsMode,
    inputLine: text
  };
}

function normalizeOrders(input) {
  if (Array.isArray(input)) return input.map(parseOrderLine).filter(order => order.rawOrderNo);
  return splitOrderInput(input).map(parseOrderLine).filter(order => order.rawOrderNo);
}

module.exports = {
  normalizeOrderNo,
  normalizeOrders,
  parseOrderLine,
  normalizeReturnMode,
  splitOrderInput
};
