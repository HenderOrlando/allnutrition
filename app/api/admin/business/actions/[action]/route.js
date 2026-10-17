import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { fail } from '@/lib/validation-core.mjs';
import { recordCollection, recordRefund, recordExpense, recordExpenseRecovery, payExpense, saveSettlement, confirmSettlement, transferMoney, closeCash, reopenCash, reverseCashEntry, reverseFinancialDocument, resolveLegacyPayment, registerReturn, preparePayroll, confirmPayroll, payPayroll, recordAdvance, recordIncome, completeOrderCosts, linkShipment } from '@/lib/business/finance.mjs';
export const runtime='nodejs';
const actions=Object.freeze({'collection':recordCollection,'refund':recordRefund,'expense':recordExpense,'expense-recovery':recordExpenseRecovery,'pay-expense':payExpense,'settlement-save':saveSettlement,'settlement-confirm':confirmSettlement,'transfer':transferMoney,'cash-close':closeCash,'cash-reopen':reopenCash,'cash-reverse':reverseCashEntry,'document-reverse':reverseFinancialDocument,'resolve-legacy-payment':resolveLegacyPayment,'return':registerReturn,'payroll-prepare':preparePayroll,'payroll-confirm':confirmPayroll,'payroll-pay':payPayroll,'advance':recordAdvance,'income':recordIncome,'complete-costs':completeOrderCosts,'link-shipment':linkShipment});
export async function POST(request,{params}) {try{
  const user=await authorize(request,{write:true}),{action}=await params;
  if(!Object.hasOwn(actions,action))fail('Acción no encontrada.',404);
  return json(await actions[action](await db(),await jsonBody(request),user.user.id));
}catch(error){return errorResponse(error);}}
