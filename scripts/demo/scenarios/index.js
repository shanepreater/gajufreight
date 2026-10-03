// Demo running order: the happy path first, then the failure modes customers ask about.
import happyPath from './happy-path.js';
import consigneeNoShow from './consignee-no-show.js';
import damagedCargoDispute from './damaged-cargo-dispute.js';
import lostShipmentRefund from './lost-shipment-refund.js';
import accessControl from './access-control.js';
import dataIntegrity from './data-integrity.js';
import panelDeadlockFallback from './panel-deadlock-fallback.js';
import packageCustody from './package-custody.js';

export const scenarios = [happyPath, consigneeNoShow, packageCustody, damagedCargoDispute, panelDeadlockFallback, lostShipmentRefund, accessControl, dataIntegrity];
