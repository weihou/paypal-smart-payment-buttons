/* @flow */

import { ZalgoPromise } from 'zalgo-promise/src';
import { INTENT, SDK_QUERY_KEYS, FUNDING } from '@paypal/sdk-constants/src';

import { INTEGRATION_ARTIFACT, USER_EXPERIENCE_FLOW, PRODUCT_FLOW } from '../constants';
import { updateClientConfig } from '../api';
import { callGraphQL } from '../api/api';
import { getLogger } from '../lib';
import { CLIENT_ID_PAYEE_NO_MATCH } from '../config';

// check whether each merchantIdsOrEmails is in payees and each payee is in merchantIds
// merchantIdsOrEmails is an arry of mixed merchant id and emails
// payees is an array of payee object {merchant_id, email}
const isValidMerchants = (merchantIdsOrEmails, payees) => {
    if (merchantIdsOrEmails.length !== payees.length) {
        return false;
    }

    // split merchantIds into 2 arrays, one for emails and one for merchant ids
    const merchantEmails = [];
    const merchantIds = [];

    merchantIdsOrEmails.forEach(id => {
        if (id.indexOf('@') === -1) {
            merchantIds.push(id);
        } else {
            merchantEmails.push(id.toLowerCase());
        }
    });

    const foundEmail = merchantEmails.every(email => {
        return payees.some(payee => {
            return (email === payee.email.toLowerCase());
        });
    });

    const foundMerchantId = merchantIds.every(id => {
        return payees.some(payee => {
            return (id === payee.merchant_id);
        });
    });

    // if the id or email is not in payees
    if (!foundEmail || !foundMerchantId) {
        return false;
    }

    // now check payees
    // each payer should either has merchant_id in merchantIds or has email in merchantEmails
    const foundPayee = payees.every(payee => {
        return (merchantIds.includes(payee.merchant_id) || merchantEmails.includes(payee.email));
    });

    return foundPayee;
};

export function updateButtonClientConfig({ orderID, fundingSource, inline = false } : { orderID : string, fundingSource : $Values<typeof FUNDING>, inline : boolean | void }) : ZalgoPromise<void> {
    return updateClientConfig({
        orderID,
        fundingSource,
        integrationArtifact: INTEGRATION_ARTIFACT.PAYPAL_JS_SDK,
        userExperienceFlow:  inline ? USER_EXPERIENCE_FLOW.INLINE : USER_EXPERIENCE_FLOW.INCONTEXT,
        productFlow:         PRODUCT_FLOW.SMART_PAYMENT_BUTTONS
    });
}

export function validateOrder(orderID : string, { clientID, merchantID } : { clientID : ?string, merchantID : $ReadOnlyArray<string> }) : ZalgoPromise<void> {
    return callGraphQL({
        query: `
            query GetCheckoutDetails($orderID: String!) {
                checkoutSession(token: $orderID) {
                    cart {
                        intent
                        amounts {
                            total {
                                currencyCode
                            }
                        }
                        payees {
                            merchant_id
                            email
                        }
                    }
                }
            }
        `,
        variables: { orderID }
    }).then(gql => {
        const cart = gql.checkoutSession.cart;

        const intent = (cart.intent.toLowerCase() === 'sale') ? INTENT.CAPTURE : cart.intent.toLowerCase();
        const currency = cart.amounts && cart.amounts.total.currencyCode;

        const expectedIntent = intent;
        const expectedCurrency = currency;

        if (intent !== expectedIntent) {
            throw new Error(`Expected intent from order api call to be ${ expectedIntent }, got ${ intent }. Please ensure you are passing ${ SDK_QUERY_KEYS.INTENT }=${ intent } to the sdk`);
        }

        if (currency && currency !== expectedCurrency) {
            throw new Error(`Expected currency from order api call to be ${ expectedCurrency }, got ${ currency }. Please ensure you are passing ${ SDK_QUERY_KEYS.CURRENCY }=${ currency } to the sdk`);
        }

        const payees = cart.payees;

        if (!merchantID || merchantID.length === 0) {
            throw new Error(`Could not determine correct merchant id`);
        }

        if (!payees || payees.length === 0) {
            throw new Error(`No payee found in transaction. Expected ${ merchantID.join() }`);
        }

        if (!isValidMerchants(merchantID, payees)) {
            if (clientID && CLIENT_ID_PAYEE_NO_MATCH.indexOf(clientID) === -1) {
                getLogger().info(`client_id_payee_no_match_${ clientID }`).flush();
                // throw new Error(`Payee passed in transaction does not match expected merchant id: ${ merchantID.join() }`);
            }
        }

        // compare merchantID and payees
        const xpropMerchantID = window.xprops.merchantID;
        if (xpropMerchantID && xpropMerchantID.length > 0 && !isValidMerchants(window.xprops.merchantID, payees)) {
            throw new Error(`Payee passed in transaction does not match expected merchant id: ${ window.xprops.merchantID }`);
        }
    });
}
