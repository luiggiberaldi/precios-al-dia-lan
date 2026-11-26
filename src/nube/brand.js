/**
 * Identidad de Precios al Día Nube: un solo lugar para el nombre visible.
 * Los archivos heredados de Bodega importan de aquí en vez de escribir el texto.
 */
import { isLanModeEnabled } from '../lan/lanConfig';

const lan = isLanModeEnabled();

export const NUBE_BRAND = Object.freeze({
    name: lan ? 'Precios al Día LAN' : 'Precios al Día Nube',
    shortName: lan ? 'PreciosAlDía LAN' : 'PreciosAlDía Nube',
    wordmark: lan ? 'PreciosAlDía LAN' : 'PreciosAlDía Nube',
    tagline: lan ? 'Tu negocio conectado en red local' : 'Tu negocio en la nube, en todas tus cajas',
    edition: lan ? 'LAN' : 'Nube',
    themeColor: '#2b59c3',
    appId: lan ? 'com.preciosaldia.lan' : 'com.preciosaldia.nube',
    deviceIdPrefix: 'PDN-',
    licenseProduct: lan ? 'lan' : 'nube',
});
