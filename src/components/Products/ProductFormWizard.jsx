import React from 'react';
import { useGranelUnitMode } from '../../utils/granel';
import ProductIdentitySection from './form/ProductIdentitySection';
import PresentationHierarchyBuilder from './form/PresentationHierarchyBuilder';
import PricingLevelsMatrix from './form/PricingLevelsMatrix';
import StockBreakdownInput from './form/StockBreakdownInput';
import ProductLivePreviewPanel from './form/ProductLivePreviewPanel';
import { usePresentationFormSync } from './form/usePresentationFormSync';

export default function ProductFormWizard(props) {
    const {
        wizardStep = 1,
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
    } = props;

    const [granelMode] = useGranelUnitMode();
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

    return (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <div className="lg:col-span-7">
                {wizardStep === 1 && (
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
                )}

                {wizardStep === 2 && (
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
                )}

                {wizardStep === 3 && (
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
                )}

                {wizardStep === 4 && (
                    <div className="space-y-4">
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
                        <div className="lg:hidden">
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
                        </div>
                    </div>
                )}
            </div>

            <div className="hidden lg:block lg:col-span-5 lg:sticky lg:top-2">
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
            </div>
        </div>
    );
}
