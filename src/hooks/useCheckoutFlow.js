import { useState, useRef } from 'react';
import { storageService } from '../utils/storageService';
import { showToast } from '../components/Toast';
import { processSaleTransaction } from '../utils/checkoutProcessor';
import { withLock } from '../utils/withLock';  // FIN-026: lock para apertura de caja.
import { round2 } from '../utils/dinero';
import { CurrencyService } from '../services/CurrencyService'; // FIN-026: safeParse en vez de parseFloat.
import { SALES_KEY } from './useSalesData';
import { buildAporteCajaRecord } from '../utils/cajaAporte';
import { useAuthStore } from './store/useAuthStore';
import { findOpenCashShift } from '../utils/cashShift';
import { appendCustomerLocked } from '../utils/customerHistory';
import { isSharedCashDrawerMode } from '../utils/cashDrawerMode';
import { hasSharedCashShiftBridge, openSharedShiftRemote } from '../nube/sharedCashShiftBridge';

export function useCheckoutFlow({
    cart, cartTotalUsd, cartTotalBs, cartSubtotalUsd, cartBaseUsd, cartIvaUsd,
    selectedCustomerId, customers, setCustomers, products, setProducts,
    effectiveRate, tasaCop, copEnabled, discountData, useAutoRate, granelUnitMode,
    setSalesData, setShowReceipt, setShowCheckout, setSelectedCustomerId,
    setCart, setCartSelectedIndex, setShowConfetti, setTodayAperturaData, setIsAperturaOpen,
    playCheckout, playError, notifyLowStock, notifySaleComplete, triggerHaptic
}) {
    const [isProcessing, setIsProcessing] = useState(false);
    const isProcessingRef = useRef(false);

    const handleCheckout = async (payments, changeBreakdown) => {
        if (isProcessingRef.current) return;
        isProcessingRef.current = true;
        setIsProcessing(true);

        triggerHaptic && triggerHaptic();

        const opts = {
            cart, cartTotalUsd, cartTotalBs, cartSubtotalUsd, cartBaseUsd, cartIvaUsd, payments, changeBreakdown,
            selectedCustomerId, customers, products, effectiveRate, tasaCop, copEnabled,
            discountData, useAutoRate, granelUnitMode,
            usuario: useAuthStore.getState()?.usuarioActivo || null,
        };

        let result;
        try {
            result = await processSaleTransaction(opts);
        } catch (err) {
            console.error('[checkout] Error inesperado en processSaleTransaction:', err);
            showToast('Error al procesar la venta. Intenta de nuevo.', 'error');
            playError();
            isProcessingRef.current = false;
            setIsProcessing(false);
            return;
        }

        if (!result.success) {
            console.error('Abortando venta:', result.error);
            showToast(result.error, result.error.includes('No se pueden') ? 'warning' : 'error');
            playError();
            isProcessingRef.current = false;
            setIsProcessing(false);
            return;
        }

        setProducts(result.updatedProducts);
        if (result.updatedCustomers) setCustomers(result.updatedCustomers);
        setSalesData(prev => [result.sale, ...prev]);

        setShowReceipt(result.sale);
        playCheckout();
        setShowConfetti(true);
        notifyLowStock(result.updatedProducts);
        notifySaleComplete && notifySaleComplete(result.sale);

        setCart([]);
        setShowCheckout(false);
        setSelectedCustomerId('');
        setCartSelectedIndex(-1);
        isProcessingRef.current = false;
        setIsProcessing(false);
    };

    const handleCreateCustomer = async (name, documentId, phone) => {
        try {
            const { customer: newCustomer, customers: updated } = await appendCustomerLocked(
                { name, documentId: documentId || '', phone: phone || '' },
                { baseCustomers: customers, storage: storageService },
            );
            setCustomers(updated);
            return newCustomer;
        } catch (err) {
            console.error('[checkout] Error al guardar cliente:', err);
            showToast('Error al guardar el cliente', 'error');
            return null;
        }
    };

    // FIN-026: handleSaveApertura envuelto en withLock + validación de montos >= 0.
    const handleSaveApertura = async (data) => {
        // Validar montos no negativos.
        const openingUsd = round2(CurrencyService.safeParse(data.openingUsd));
        const openingBs = round2(CurrencyService.safeParse(data.openingBs));
        const openingCop = round2(CurrencyService.safeParse(data.openingCop));

        if (openingUsd < 0 || openingBs < 0 || openingCop < 0) {
            showToast('Los montos de apertura no pueden ser negativos.', 'error');
            if (playError) playError();
            return;
        }

        try {
            const today = new Date().toISOString();
            const sharedMode = isSharedCashDrawerMode();
            const activeUser = useAuthStore.getState()?.usuarioActivo || null;
            const shiftId = sharedMode ? `shift_${Date.now()}` : null;
            let aperturaRecord = {
                id: `apertura_${Date.now()}`,
                tipo: 'APERTURA_CAJA',
                openingUsd,
                openingBs,
                // FIN-026: incluir openingCop siempre (aunque sea 0) para trazabilidad.
                openingCop,
                timestamp: today,
                cajaCerrada: false,
                ...(shiftId ? {
                    shiftId,
                    sharedDrawer: true,
                    cashier: { nombre: activeUser?.nombre || 'Usuario', rol: activeUser?.rol || 'CAJERO' },
                } : {}),
            };

            let remoteAlreadyOpen = false;
            if (sharedMode && hasSharedCashShiftBridge()) {
                try {
                    const remoteRes = await openSharedShiftRemote(shiftId, aperturaRecord);
                    if (remoteRes?.opening_record) {
                        aperturaRecord = remoteRes.opening_record;
                    }
                    if (remoteRes?.already_open) {
                        remoteAlreadyOpen = true;
                    }
                } catch (remoteErr) {
                    // Si la red LAN está caída temporalmente, permitir apertura local con shiftId
                    console.warn('[apertura] No se pudo coordinar turno compartido remoto; abriendo en local:', remoteErr?.message || remoteErr);
                }
            }

            // FIN-026: envolver en withLock para evitar duplicar aperturas en doble-click.
            // CAJA-APERTURA-001: si ya hay una caja abierta (otra pestaña o pantalla
            // desactualizada) no se crea otra: su fondo quedaría fuera de las cuentas,
            // porque solo cuenta la apertura abierta más reciente.
            let alreadyOpen = null;
            await withLock('pos_write_lock', async () => {
                const existingSales = await storageService.getItem(SALES_KEY, []);
                alreadyOpen = findOpenCashShift(existingSales);
                if (alreadyOpen) {
                    setTodayAperturaData(alreadyOpen);
                    return;
                }
                const alreadyExistsById = existingSales.some((s) => String(s?.id) === String(aperturaRecord.id));
                const updatedSales = alreadyExistsById ? existingSales : [...existingSales, aperturaRecord];
                await storageService.setItem(SALES_KEY, updatedSales);
                setTodayAperturaData(aperturaRecord);
            });

            setIsAperturaOpen(false);
            if (alreadyOpen || remoteAlreadyOpen) {
                showToast(
                    remoteAlreadyOpen
                        ? 'La caja compartida ya estaba abierta desde otro equipo.'
                        : 'La caja ya estaba abierta. Se usa la apertura existente.',
                    'info',
                );
                return;
            }
            showToast(sharedMode ? 'Caja compartida abierta para todos los equipos' : 'Caja abierta exitosamente', 'success');
            if (triggerHaptic) triggerHaptic();

        } catch (error) {
            console.error('Error al guardar apertura:', error);
            showToast('Error al abrir la caja', 'error');
            if (playError) playError();
        }
    };

    // Aporte de efectivo a la caja. Permiso: con login activo solo ADMIN (un CAJERO no);
    // sin login (requireLogin=false) cualquiera con acceso a la caja, igual que la apertura.
    // Decidido por el dueño (2026-10-13). El permiso se valida aquí, no solo en la UI.
    const handleSaveAporte = async (data) => {
        const { requireLogin, usuarioActivo } = useAuthStore.getState();
        if (requireLogin && usuarioActivo?.rol !== 'ADMIN') {
            showToast('Solo el administrador puede registrar aportes de efectivo.', 'error');
            if (playError) playError();
            return false;
        }

        let record;
        try {
            record = buildAporteCajaRecord({ ...data, usuario: usuarioActivo });
        } catch (err) {
            showToast(err.message, 'error');
            if (playError) playError();
            return false;
        }

        try {
            await withLock('pos_write_lock', async () => {
                const existingSales = await storageService.getItem(SALES_KEY, []);
                const openShift = findOpenCashShift(existingSales);
                const stamped = openShift?.shiftId ? { ...record, shiftId: openShift.shiftId } : record;
                await storageService.setItem(SALES_KEY, [...existingSales, stamped]);
                setSalesData(prev => [stamped, ...prev]);
            });
            showToast('Aporte de efectivo registrado', 'success');
            if (triggerHaptic) triggerHaptic();
            return true;
        } catch (error) {
            console.error('Error al registrar aporte de caja:', error);
            showToast('Error al registrar el aporte', 'error');
            if (playError) playError();
            return false;
        }
    };

    return {
        handleCheckout,
        handleCreateCustomer,
        handleSaveApertura,
        handleSaveAporte,
        isProcessing
    };
}
