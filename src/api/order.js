/* @flow */

import type { ZalgoPromise } from 'zalgo-promise/src';
import { FPTI_KEY, FUNDING, WALLET_INSTRUMENT, INTENT } from '@paypal/sdk-constants/src';
import { request, noop, memoize } from 'belter/src';

import { SMART_API_URI, ORDERS_API_URL, VALIDATE_PAYMENT_METHOD_API } from '../config';
import { getLogger } from '../lib';
import { FPTI_TRANSITION, FPTI_CONTEXT_TYPE, HEADERS } from '../constants';

import { callSmartAPI, callGraphQL, callRestAPI } from './api';

export type OrderCreateRequest = {|
    intent? : 'CAPTURE' | 'AUTHORIZE',
        purchase_units : $ReadOnlyArray<{|
            amount : {|
                currency_code : string,
                value : string
            |},
            payee? : {|
                merchant_id? : string
            |}
        |}>
|};

export type OrderResponse = {||};
export type OrderCaptureResponse = {||};
export type OrderGetResponse = {||};
export type OrderAuthorizeResponse = {||};

type OrderAPIOptions = {|
    facilitatorAccessToken : string,
    buyerAccessToken? : ?string,
    partnerAttributionID : ?string,
    forceRestAPI? : boolean
|};

export function createOrderID(order : OrderCreateRequest, { facilitatorAccessToken, partnerAttributionID } : OrderAPIOptions) : ZalgoPromise<string> {
    getLogger().info(`rest_api_create_order_id`);

    return callRestAPI({
        accessToken: facilitatorAccessToken,
        method:      `post`,
        url:         `${ ORDERS_API_URL }`,
        data:        order,
        headers:     {
            [ HEADERS.PARTNER_ATTRIBUTION_ID ]: partnerAttributionID || ''
        }
    }).then((body) : string => {

        const orderID = body && body.id;

        if (!orderID) {
            throw new Error(`Order Api response error:\n\n${ JSON.stringify(body, null, 4) }`);
        }

        getLogger().track({
            [FPTI_KEY.TRANSITION]:   FPTI_TRANSITION.CREATE_ORDER,
            [FPTI_KEY.CONTEXT_TYPE]: FPTI_CONTEXT_TYPE.ORDER_ID,
            [FPTI_KEY.TOKEN]:        orderID,
            [FPTI_KEY.CONTEXT_ID]:   orderID
        });

        return orderID;
    });
}

export function getOrder(orderID : string, { facilitatorAccessToken, buyerAccessToken, partnerAttributionID, forceRestAPI = false } : OrderAPIOptions) : ZalgoPromise<OrderResponse> {
    return forceRestAPI
        ? callRestAPI({
            accessToken: facilitatorAccessToken,
            url:         `${ ORDERS_API_URL }/${ orderID }`,
            headers:     {
                [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
            }
        })
        : callSmartAPI({
            accessToken: buyerAccessToken,
            url:         `${ SMART_API_URI.ORDER }/${ orderID }`,
            headers:     {
                [HEADERS.CLIENT_CONTEXT]:         orderID
            }
        });
}

export function captureOrder(orderID : string, { facilitatorAccessToken, buyerAccessToken, partnerAttributionID, forceRestAPI = false } : OrderAPIOptions) : ZalgoPromise<OrderResponse> {
    return forceRestAPI
        ? callRestAPI({
            accessToken: facilitatorAccessToken,
            method:      `post`,
            url:         `${ ORDERS_API_URL }/${ orderID }/capture`,
            headers:     {
                [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
            }
        })
        : callSmartAPI({
            accessToken: buyerAccessToken,
            method:      'post',
            url:         `${ SMART_API_URI.ORDER }/${ orderID }/capture`,
            headers:     {
                [HEADERS.CLIENT_CONTEXT]: orderID
            }
        });
}

export function authorizeOrder(orderID : string, { facilitatorAccessToken, buyerAccessToken, partnerAttributionID, forceRestAPI = false } : OrderAPIOptions) : ZalgoPromise<OrderResponse> {
    return forceRestAPI
        ? callRestAPI({
            accessToken: facilitatorAccessToken,
            method:      `post`,
            url:         `${ ORDERS_API_URL }/${ orderID }/authorize`,
            headers:     {
                [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
            }
        })
        : callSmartAPI({
            accessToken: buyerAccessToken,
            method:      'post',
            url:         `${ SMART_API_URI.ORDER }/${ orderID }/authorize`,
            headers:     {
                [HEADERS.CLIENT_CONTEXT]: orderID
            }
        });
}

type PatchData = {|
    
|};

export function patchOrder(orderID : string, data : PatchData, { facilitatorAccessToken, buyerAccessToken, partnerAttributionID, forceRestAPI = false } : OrderAPIOptions) : ZalgoPromise<OrderResponse> {
    const patchData = Array.isArray(data) ? { patch: data } : data;

    return forceRestAPI
        ? callRestAPI({
            accessToken: facilitatorAccessToken,
            method:      `patch`,
            url:         `${ ORDERS_API_URL }/${ orderID }`,
            data:        patchData,
            headers:     {
                [HEADERS.PARTNER_ATTRIBUTION_ID]: partnerAttributionID || ''
            }
        })
        : callSmartAPI({
            accessToken: buyerAccessToken,
            method:      'post',
            url:         `${ SMART_API_URI.ORDER }/${ orderID }/patch`,
            json:        { data: patchData },
            headers:     {
                [HEADERS.CLIENT_CONTEXT]: orderID
            }
        });
}

export type ValidatePaymentMethodOptions = {|
    clientAccessToken : string,
    orderID : string,
    paymentMethodID : string,
    enableThreeDomainSecure : boolean,
    partnerAttributionID : ?string,
    clientMetadataID : string
|};

const VALIDATE_CONTINGENCIES = {
    THREE_DOMAIN_SECURE: '3D_SECURE'
};

export type ValidatePaymentMethodResponse = {|
    links? : $ReadOnlyArray<{|
        rel : string
    |}>
|};

type PaymentSource = {|
    token : {|
        id : string,
        type : 'NONCE'
    |},
    contingencies? : $ReadOnlyArray<$Values<typeof VALIDATE_CONTINGENCIES>>
|};

export function validatePaymentMethod({ clientAccessToken, orderID, paymentMethodID, enableThreeDomainSecure, partnerAttributionID, clientMetadataID } : ValidatePaymentMethodOptions) : ZalgoPromise<{| status : number, body : ValidatePaymentMethodResponse, headers : { [string] : string } |}> {
    getLogger().info(`rest_api_create_order_token`);

    const headers : Object = {
        [ HEADERS.AUTHORIZATION ]:          `Bearer ${ clientAccessToken }`,
        [ HEADERS.PARTNER_ATTRIBUTION_ID ]: partnerAttributionID,
        [ HEADERS.CLIENT_METADATA_ID ]:     clientMetadataID
    };

    const paymentSource : PaymentSource = {
        token: {
            id:   paymentMethodID,
            type: 'NONCE'
        }
    };

    if (enableThreeDomainSecure) {
        paymentSource.contingencies = [ VALIDATE_CONTINGENCIES.THREE_DOMAIN_SECURE ];
    }

    const json = {
        payment_source: paymentSource
    };

    return request({
        method: `post`,
        url:    `${ ORDERS_API_URL }/${ orderID }/${ VALIDATE_PAYMENT_METHOD_API }`,
        headers,
        json
    });
}

export function billingTokenToOrderID(billingToken : string) : ZalgoPromise<string> {
    return callSmartAPI({
        method: 'post',
        url:    `${ SMART_API_URI.PAYMENT }/${ billingToken }/ectoken`
    }).then(data => {
        return data.token;
    });
}

export function subscriptionIdToCartId(subscriptionID : string) : ZalgoPromise<string> {
    return callSmartAPI({
        method: 'post',
        url:    `${ SMART_API_URI.SUBSCRIPTION }/${ subscriptionID }/cartid`
    }).then(data => {
        return data.token;
    });
}

export function enableVault({ orderID, clientAccessToken } : {| orderID : string, clientAccessToken : string |}) : ZalgoPromise<mixed> {
    return callGraphQL({
        name:  'EnableVault',
        query: `
            mutation EnableVault(
                $orderID : String!
            ) {
                enableVault(
                    token: $orderID
                )
            }
        `,
        variables: {
            orderID
        },
        headers: {
            [ HEADERS.ACCESS_TOKEN ]:   clientAccessToken,
            [ HEADERS.CLIENT_CONTEXT ]: orderID
        }
    });
}

export function deleteVault({ paymentMethodID, clientAccessToken } : {| paymentMethodID : string, clientAccessToken : string |}) : ZalgoPromise<mixed> {
    return callGraphQL({
        name:  'DeleteVault',
        query: `
            mutation DeleteVault(
                $paymentMethodID : String!
            ) {
                deleteVault(
                    paymentMethodID: $paymentMethodID
                )
            }
        `,
        variables: {
            paymentMethodID
        },
        headers: {
            [ HEADERS.ACCESS_TOKEN ]: clientAccessToken
        }
    });
}

type ClientConfig = {|
    orderID : string,
    fundingSource : $Values<typeof FUNDING>,
    integrationArtifact : string,
    userExperienceFlow : string,
    productFlow : string
|};

export function updateClientConfig({ orderID, fundingSource, integrationArtifact, userExperienceFlow, productFlow } : ClientConfig) : ZalgoPromise<void> {
    return callGraphQL({
        name:  'UpdateClientConfig',
        query: `
            mutation UpdateClientConfig(
                $orderID : String!,
                $fundingSource : ButtonFundingSourceType!,
                $integrationArtifact : IntegrationArtifactType!,
                $userExperienceFlow : UserExperienceFlowType!,
                $productFlow : ProductFlowType!
            ) {
                updateClientConfig(
                    token: $orderID,
                    fundingSource: $fundingSource,
                    integrationArtifact: $integrationArtifact,
                    userExperienceFlow: $userExperienceFlow,
                    productFlow: $productFlow
                )
            }
        `,
        variables: { orderID, fundingSource, integrationArtifact, userExperienceFlow, productFlow },
        headers:   {
            [HEADERS.CLIENT_CONTEXT]: orderID
        }
    }).then(noop);
}

type ApproveOrderOptions = {|
    orderID : string,
    planID : string,
    buyerAccessToken : string
|};

type ApproveData = {|
    payerID : string
|};

export function approveOrder({ orderID, planID, buyerAccessToken } : ApproveOrderOptions) : ZalgoPromise<ApproveData> {
    return callGraphQL({
        name:  'ApproveOrder',
        query: `
            mutation ApproveOrder(
                $orderID : String!
                $planID : String!
            ) {
                approvePayment(
                    token: $orderID
                    selectedPlanId: $planID
                ) {
                    buyer {
                        userId
                    }
                }
            }
        `,
        variables: { orderID, planID },
        headers:   {
            [ HEADERS.ACCESS_TOKEN ]:   buyerAccessToken,
            [ HEADERS.CLIENT_CONTEXT ]: orderID
        }
    }).then(({ approvePayment }) => {
        return {
            payerID: approvePayment.buyer.userId
        };
    });
}

type OneClickApproveOrderOptions = {|
    orderID : string,
    instrumentType : $Values<typeof WALLET_INSTRUMENT>,
    instrumentID : string,
    buyerAccessToken : string
|};

export function oneClickApproveOrder({ orderID, instrumentType, instrumentID, buyerAccessToken } : OneClickApproveOrderOptions) : ZalgoPromise<ApproveData> {
    return callGraphQL({
        name:  'OneClickApproveOrder',
        query: `
            mutation OneClickApproveOrder(
                $orderID : String!
                $instrumentType : String!
                $instrumentID : String!
            ) {
                oneClickPayment(
                    token: $orderID
                    selectedInstrumentType : $instrumentType
                    selectedInstrumentId : $instrumentID
                ) {
                    userId
                }
            }
        `,
        variables: { orderID, instrumentType, instrumentID },
        headers:   {
            [HEADERS.ACCESS_TOKEN]:   buyerAccessToken,
            [HEADERS.CLIENT_CONTEXT]: orderID
        }
    }).then(({ oneClickPayment }) => {
        return {
            payerID: oneClickPayment.userId
        };
    });
}

type SupplementalOrderInfo = {|
    checkoutSession : {|
        cart : {|
            intent : $Values<typeof INTENT>,
            paymentId? : ?string,
            billingToken? : ?string,
            amounts? : {|
                total : {|
                    currencyCode : string
                |}
            |},
            shippingAddress? : {|
                isFullAddress? : boolean
            |}
        |},
        buyer? : {|
            userId? : string
        |},
        flags : {|
            isShippingAddressRequired? : boolean
        |},
        payees? : $ReadOnlyArray<{|
            merchantId? : string,
            email? : {|
                stringValue? : string
            |}
        |}>
    |}
|};

export const getSupplementalOrderInfo = memoize((orderID : string) : ZalgoPromise<SupplementalOrderInfo> => {
    return callGraphQL({
        name:  'GetCheckoutDetails',
        query: `
            query GetCheckoutDetails($orderID: String!) {
                checkoutSession(token: $orderID) {
                    cart {
                        intent
                        paymentId
                        billingToken
                        amounts {
                            total {
                                currencyCode
                            }
                        }
                        shippingAddress {
                            isFullAddress
                        }
                    }
                    flags {
                        hideShipping
                        isShippingAddressRequired
                        isChangeShippingAddressAllowed
                    },
                    payees {
                        merchantId
                        email {
                            stringValue
                        }
                    }
                }
            }
        `,
        variables: { orderID },
        headers:   {
            [HEADERS.CLIENT_CONTEXT]: orderID
        }
    });
});
