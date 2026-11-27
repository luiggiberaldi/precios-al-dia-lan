import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { useGranelUnitMode } from '../../utils/granel';
import ProductIdentitySection from './form/ProductIdentitySection';
import PresentationHierarchyBuilder from './form/PresentationHierarchyBuilder';
import PricingLevelsMatrix from './form/PricingLevelsMatrix';
import StockBreakdownInput from './form/StockBreakdownInput';
import ProductLivePreviewPanel from './form/ProductLivePreviewPanel';
import { usePresentationFormSync } from './form/usePresentationFormSync';

export default function ProductFormQuick(props) {
    const {
        editingId = null,
        image, setImage,
        name, setName,
        barcode, setBarcode,
        category, setCategory,
        priceUsd, handlePriceUsdChange,
        priceBs, handlePriceBsChange,
        pricingMode, setPricingMode,
        priceBsUsdRef, setPriceBsUsdRef,
        handlePriceCopChange,
        priceCop,
        costUsd, handleCostUsdChange,
        costBs, handleCostBsChange,
        costCop, handleCostCopChange,
        costFactor, handleCostFactorChange,
        stock, setStock,
        lowStockAlert, setLowStockAlert,
        ivaMode, setIvaMode,
        granelUnit, setGranelUnit,
        effectiveRate,
        copEnabled,
        copPrimary,
        tasaCop,
        handleImageUpload,
        categories,
        isSearchingImage,
        handleAutoSearchImage,
        imageMatches,
        setImageMatches,
        handleSelectImage,
        footerAction = null,
    } = props;

    const [granelMode] = useGranelUnitMode();
    const [showMobilePreview, setShowMobilePreview] = useState(false);

    const {
        packagingMode,
        presentations,
        costSourceLevel,
        stockByLevel,
        setStockByLevel,
        handleSelectMode,
        handleChangePresentations,
        handleChangeCostSourceLevel,
    } = usePresentationFormSync(props);

    const previewNode = (
        <ProductLivePreviewPanel
            name={name}
            barcode={barcode}
            image={image}
            packagingMode={packagingMode}
            presentations={presentations}
            stock={stock}
            stockByLevel={stockByLevel}
            priceUsd={priceUsd}
            effectiveRate={effectiveRate}
            copEnabled={copEnabled}
            copPrimary={copPrimary}
            tasaCop={tasaCop}
        />
    );

    return (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Columna izquierda: formulario modular progresivo */}
            <div className="lg:col-span-7 space-y-5">
                <ProductIdentitySection
                    editingId={editingId}
                    image={image} setImage={setImage}
                    name={name} setName={setName}
                    barcode={barcode} setBarcode={setBarcode}
                    category={category} setCategory={setCategory}
                    categories={categories}
                    ivaMode={ivaMode} setIvaMode={setIvaMode}
                    handleImageUpload={handleImageUpload}
                    isSearchingImage={isSearchingImage}
                    handleAutoSearchImage={handleAutoSearchImage}
                    imageMatches={imageMatches}
                    setImageMatches={setImageMatches}
                    handleSelectImage={handleSelectImage}
                />

                <div className="border-t border-surface-200 dark:border-surface-800 pt-4">
                    <PresentationHierarchyBuilder
                        editingId={editingId}
                        packagingMode={packagingMode}
                        onSelectMode={handleSelectMode}
                        presentations={presentations}
                        onChangePresentations={handleChangePresentations}
                        granelUnit={granelUnit}
                        setGranelUnit={setGranelUnit}
                        granelMode={granelMode}
                    />
                </div>

                <div className="border-t border-surface-200 dark:border-surface-800 pt-4">
                    <PricingLevelsMatrix
                        packagingMode={packagingMode}
                        presentations={presentations}
                        onChangePresentations={handleChangePresentations}
                        costSourceLevel={costSourceLevel}
                        onChangeCostSourceLevel={handleChangeCostSourceLevel}
                        priceUsd={priceUsd} handlePriceUsdChange={handlePriceUsdChange}
                        priceBs={priceBs} handlePriceBsChange={handlePriceBsChange}
                        priceCop={priceCop} handlePriceCopChange={handlePriceCopChange}
                        pricingMode={pricingMode} setPricingMode={setPricingMode}
                        priceBsUsdRef={priceBsUsdRef} setPriceBsUsdRef={setPriceBsUsdRef}
                        costUsd={costUsd} handleCostUsdChange={handleCostUsdChange}
                        costBs={costBs} handleCostBsChange={handleCostBsChange}
                        costCop={costCop} handleCostCopChange={handleCostCopChange}
                        costFactor={costFactor} handleCostFactorChange={handleCostFactorChange}
                        effectiveRate={effectiveRate}
                        copEnabled={copEnabled}
                        copPrimary={copPrimary}
                        tasaCop={tasaCop}
                        ivaMode={ivaMode}
                        granelUnit={granelUnit}
                    />
                </div>

                <div className="border-t border-surface-200 dark:border-surface-800 pt-4">
                    <StockBreakdownInput
                        packagingMode={packagingMode}
                        presentations={presentations}
                        stock={stock}
                        setStock={setStock}
                        stockByLevel={stockByLevel}
                        setStockByLevel={setStockByLevel}
                        lowStockAlert={lowStockAlert}
                        setLowStockAlert={setLowStockAlert}
                        granelUnit={granelUnit}
                        granelMode={granelMode}
                    />
                </div>

                {/* Acordeón móvil de Vista Previa */}
                <div className="lg:hidden border border-surface-200 dark:border-surface-800 rounded-2xl overflow-hidden">
                    <button
                        type="button"
                        onClick={() => setShowMobilePreview(!showMobilePreview)}
                        className="w-full min-h-[44px] flex items-center justify-between px-3.5 py-2.5 bg-surface-50 dark:bg-surface-800/60 text-xs font-bold text-surface-600 dark:text-surface-300 cursor-pointer"
                    >
                        <span className="flex items-center gap-1.5">
                            <Eye size={14} aria-hidden="true" /> Vista previa y coherencia en Caja
                        </span>
                        {showMobilePreview ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                    </button>
                    {showMobilePreview && <div className="p-2">{previewNode}</div>}
                </div>
            </div>

            {/* Columna derecha sticky (desktop): vista previa viva + CTA primario */}
            <div className="hidden lg:block lg:col-span-5 lg:sticky lg:top-2 space-y-4">
                {previewNode}
                {footerAction}
            </div>
        </div>
    );
}
