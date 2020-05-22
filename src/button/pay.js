/* @flow */

import { noop, stringifyError } from 'belter/src';
import { ZalgoPromise } from 'zalgo-promise/src';
import { FPTI_KEY } from '@paypal/sdk-constants/src';

import { checkout, cardFields, native, honey, vaultCapture, walletCapture, popupBridge, type Payment, type PaymentFlow } from '../payment-flows';
import { sendBeacon, getLogger, promiseNoop } from '../lib';
import { FPTI_TRANSITION } from '../constants';

import { type ButtonProps, type Config, type ServiceData, type Components } from './props';
import { enableLoadingSpinner, disableLoadingSpinner } from './dom';
import { updateButtonClientConfig, validateOrder } from './orders';
import { renderMenu } from './menu';

const PAYMENT_FLOWS : $ReadOnlyArray<PaymentFlow> = [
    vaultCapture,
    walletCapture,
    cardFields,
    popupBridge,
    native,
    checkout,
    honey
];

export function setupPaymentFlows({ props, config, serviceData, components } : {| props : ButtonProps, config : Config, serviceData : ServiceData, components : Components |}) : ZalgoPromise<void> {
    return ZalgoPromise.all(PAYMENT_FLOWS.map(flow => {
        return flow.isEligible({ props, config, serviceData })
            ? flow.setup({ props, config, serviceData, components })
            : null;
    })).then(noop);
}

export function getPaymentFlow({ props, payment, config, serviceData } : {| props : ButtonProps, payment : Payment, config : Config, components : Components, serviceData : ServiceData |}) : PaymentFlow {
    for (const flow of PAYMENT_FLOWS) {
        if (flow.isEligible({ props, config, serviceData }) && flow.isPaymentEligible({ props, payment, config, serviceData })) {
            return flow;
        }
    }

    throw new Error(`Could not find eligible payment flow`);
}

const sendPersonalizationBeacons = (personalization) => {
    if (personalization && personalization.tagline && personalization.tagline.tracking) {
        sendBeacon(personalization.tagline.tracking.click);
    }
    if (personalization && personalization.buttonText && personalization.buttonText.tracking) {
        sendBeacon(personalization.buttonText.tracking.click);
    }
};

type InitiatePaymentOptions = {|
    payment : Payment,
    props : ButtonProps,
    serviceData : ServiceData,
    config : Config,
    components : Components
|};

export function initiatePaymentFlow({ payment, serviceData, config, components, props } : InitiatePaymentOptions) : ZalgoPromise<void> {
    const { button, fundingSource } = payment;

    return ZalgoPromise.try(() => {
        const { personalization, merchantID } = serviceData;
        const { clientID, onClick, createOrder, env } = props;

        sendPersonalizationBeacons(personalization);

        const { name, init, inline, spinner, instant = false } = getPaymentFlow({ props, payment, config, components, serviceData });
        const { click = promiseNoop, start, close } = init({ props, config, serviceData, components, payment });

        const clickPromise = ZalgoPromise.try(click);
        clickPromise.catch(noop);

        getLogger().info(`button_click`).info(`pay_flow_${ name }`).track({
            [FPTI_KEY.TRANSITION]:     FPTI_TRANSITION.BUTTON_CLICK,
            [FPTI_KEY.CHOSEN_FUNDING]: fundingSource,
            [FPTI_KEY.PAYMENT_FLOW]:   name
        }).flush();

        return ZalgoPromise.hash({
            valid: onClick ? onClick({ fundingSource }) : true
        }).then(({ valid }) => {
            if (!valid) {
                return;
            }

            if (spinner) {
                enableLoadingSpinner(button);
            }

            const clientConfigPromise = createOrder()
                .then(orderID => updateButtonClientConfig({ orderID, fundingSource, inline }))
                .catch(err => getLogger().error('update_client_config_error', { err: stringifyError(err) }));

            const {
                intent:   expectedIntent,
                currency: expectedCurrency
            } = props;

            return ZalgoPromise.resolve()
                .then(() => (instant ? clientConfigPromise : null))
                .then(() => start())
                .then(() => createOrder())
                .then(orderID => validateOrder(orderID, { env, clientID, merchantID, expectedCurrency, expectedIntent }))
                .then(() => clickPromise)
                .catch(err => {
                    return ZalgoPromise.all([
                        close(),
                        ZalgoPromise.reject(err)
                    ]);
                }).then(noop);
        });

    }).finally(() => {
        disableLoadingSpinner(button);
    });
}

type InitiateMenuOptions = {|
    payment : Payment,
    props : ButtonProps,
    serviceData : ServiceData,
    config : Config,
    components : Components,
    initiatePayment : ({| payment : Payment |}) => ZalgoPromise<void>
|};

export function initiateMenuFlow({ payment, serviceData, config, components, props, initiatePayment } : InitiateMenuOptions) : ZalgoPromise<void> {
    return ZalgoPromise.try(() => {
        const { fundingSource, button } = payment;

        const { name, setupMenu } = getPaymentFlow({ props, payment, config, components, serviceData });

        if (!setupMenu) {
            throw new Error(`${ name } does not support menu`);
        }

        getLogger().info(`menu_click`).info(`pay_flow_${ name }`).track({
            [FPTI_KEY.TRANSITION]:     FPTI_TRANSITION.MENU_CLICK,
            [FPTI_KEY.CHOSEN_FUNDING]: fundingSource,
            [FPTI_KEY.PAYMENT_FLOW]:   name
        }).flush();

        const choices = setupMenu({ props, payment, serviceData, initiatePayment }).map(choice => {
            return {
                ...choice,
                onSelect: (...args) => {
                    if (choice.spinner) {
                        enableLoadingSpinner(button);
                    }

                    return ZalgoPromise.try(() => {
                        return choice.onSelect(...args);
                    }).then(() => {
                        if (choice.spinner) {
                            disableLoadingSpinner(button);
                        }
                    });
                }
            };
        });

        return renderMenu({ props, payment, components, choices });
    });
}
