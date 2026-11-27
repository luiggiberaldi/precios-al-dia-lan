import React, { useRef, useState } from 'react';
import { Camera, X, Barcode, CheckCircle, Plus, Sparkles, Tag, Percent } from 'lucide-react';
import { useProductContext } from '../../../context/ProductContext';
import CustomSelect from '../../CustomSelect';
import { showToast } from '../../Toast';
import BarcodeDuplicateHint from '../BarcodeDuplicateHint';
import SimilarNameHint from '../SimilarNameHint';
import { resolveLanImageUrl } from '../../../utils/imageFallback';

export default function ProductIdentitySection({
    editingId = null,
    image, setImage,
    name, setName,
    barcode, setBarcode,
    category, setCategory,
    categories = [],
    ivaMode, setIvaMode,
    handleImageUpload,
    isSearchingImage = false,
    handleAutoSearchImage,
    imageMatches = [],
    setImageMatches,
    handleSelectImage,
}) {
    const fileInputRef = useRef(null);
    const ctx = useProductContext() || {};
    const setCategories = ctx.setCategories;

    const [isAddingCategory, setIsAddingCategory] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');

    const handleAddCategory = () => {
        if (!newCategoryName.trim()) return;
        const catId = newCategoryName.trim().toLowerCase().replace(/\s+/g, '_');
        if (typeof setCategories === 'function') {
            setCategories((prev) => {
                if (prev.find((c) => c.id === catId)) return prev;
                return [...prev, { id: catId, label: newCategoryName.trim(), icon: '◆', color: 'emerald' }];
            });
        }
        setCategory(catId);
        setIsAddingCategory(false);
        setNewCategoryName('');
    };

    const normalizedCategories = (Array.isArray(categories) ? categories : [])
        .map((c) => (typeof c === 'string' ? { id: c, label: c } : c))
        .filter((c) => c && c.id !== 'todos');

    return (
        <section className="space-y-3.5" aria-label="Identidad del producto">
            {/* Foto compacta + Nombre en horizontal */}
            <div className="flex items-start gap-3">
                <div className="shrink-0 flex flex-col gap-1.5">
                    <div
                        role="button"
                        tabIndex={0}
                        onClick={() => fileInputRef.current?.click()}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                fileInputRef.current?.click();
                            }
                        }}
                        aria-label="Subir foto local del producto"
                        className="w-[84px] h-[84px] bg-surface-50 dark:bg-surface-800 border-2 border-dashed border-surface-300 dark:border-surface-700 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition-colors relative overflow-hidden p-1.5 text-center"
                    >
                        {image ? (
                            <img src={resolveLanImageUrl(image)} className="w-full h-full object-cover rounded-xl" alt={name || 'Foto del producto'} />
                        ) : (
                            <>
                                <Camera size={20} className="text-surface-400 mb-1" aria-hidden="true" />
                                <span className="text-[10px] font-bold text-surface-500 leading-tight">Subir foto</span>
                            </>
                        )}
                        <input
                            type="file"
                            ref={fileInputRef}
                            className="hidden"
                            accept="image/*"
                            onChange={handleImageUpload}
                            aria-label="Seleccionar archivo de imagen"
                        />
                        {image && (
                            <button
                                type="button"
                                aria-label="Quitar foto"
                                onClick={(e) => { e.stopPropagation(); setImage(''); }}
                                className="absolute top-1 right-1 min-w-6 min-h-6 w-6 h-6 bg-black/65 hover:bg-black/80 text-white rounded-full flex items-center justify-center cursor-pointer"
                            >
                                <X size={12} aria-hidden="true" />
                            </button>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={() => {
                            if (!name || name.trim().length < 3) {
                                showToast('Ingresa el nombre del producto (mín. 3 letras) para buscar automáticamente', 'warning');
                                return;
                            }
                            handleAutoSearchImage?.(name);
                        }}
                        className="min-h-[36px] px-2 rounded-xl border border-amber-300/70 dark:border-amber-700/50 bg-amber-50/70 dark:bg-amber-900/20 hover:bg-amber-100/80 text-amber-800 dark:text-amber-300 text-[10px] font-black uppercase tracking-wide flex items-center justify-center gap-1 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                    >
                        {isSearchingImage ? (
                            <span className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-amber-600 border-t-transparent" />
                        ) : (
                            <Sparkles size={12} aria-hidden="true" />
                        )}
                        <span>{isSearchingImage ? 'Buscando' : 'Auto-foto'}</span>
                    </button>
                </div>

                {/* Nombre principal */}
                <div className="flex-1 min-w-0">
                    <label htmlFor="product-name-input" className="text-xs font-bold text-surface-500 dark:text-surface-400 ml-1 mb-1 block uppercase tracking-wide">
                        Nombre del Artículo
                    </label>
                    <div className="relative">
                        <input
                            id="product-name-input"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                            placeholder="Ej: Harina PAN 1kg"
                            className="w-full min-h-[44px] bg-surface-50 dark:bg-surface-800 px-3.5 py-2.5 pr-10 rounded-xl font-bold text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 capitalize text-sm sm:text-base transition-all"
                        />
                        {name && name.trim().length >= 3 && (
                            <CheckCircle size={18} aria-hidden="true" className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500" />
                        )}
                    </div>
                    <SimilarNameHint name={name} exceptId={editingId} />
                </div>
            </div>

            {/* Galería de resultados auto-foto */}
            {imageMatches && imageMatches.length > 0 && (
                <div className="bg-surface-50 dark:bg-surface-800/40 border border-surface-200 dark:border-surface-700/60 rounded-2xl p-3 space-y-2 select-none">
                    <div className="flex justify-between items-center px-0.5">
                        <span className="text-[10px] font-black text-amber-700 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1">
                            <Sparkles size={11} aria-hidden="true" /> Selecciona la foto correcta ({imageMatches.length})
                        </span>
                        <button
                            type="button"
                            onClick={() => setImageMatches?.([])}
                            className="min-h-[32px] px-2 text-[10px] font-extrabold text-surface-500 hover:text-surface-700 dark:hover:text-surface-200 uppercase tracking-wider cursor-pointer"
                        >
                            Cerrar
                        </button>
                    </div>
                    <div className="flex gap-2.5 overflow-x-auto pb-1.5 items-stretch">
                        {imageMatches.map((m, idx) => (
                            <button
                                key={idx}
                                type="button"
                                onClick={() => handleSelectImage?.(m.dataUri)}
                                className="flex-shrink-0 w-24 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-xl p-1.5 cursor-pointer hover:border-amber-500 transition-all flex flex-col items-center justify-between gap-1.5 text-center"
                            >
                                <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-50 dark:bg-surface-800 flex items-center justify-center shrink-0">
                                    <img src={m.dataUri} className="w-full h-full object-cover" alt={m.title || 'Opción'} crossOrigin="anonymous" />
                                </div>
                                <span className="text-[9px] font-bold text-surface-600 dark:text-surface-300 leading-tight uppercase line-clamp-2 w-full">
                                    {m.title}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Código de barras + Categoría */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label htmlFor="product-barcode-input" className="text-xs font-bold text-surface-500 dark:text-surface-400 ml-1 mb-1 block uppercase tracking-wide">
                        Cód. de Barras Base (Opcional)
                    </label>
                    <div className="relative">
                        <input
                            id="product-barcode-input"
                            value={barcode}
                            onChange={(e) => setBarcode(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                            placeholder="Ej: 7591111222233"
                            className="w-full min-h-[44px] bg-surface-50 dark:bg-surface-800 px-3.5 py-2.5 pl-10 rounded-xl font-mono font-bold text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 text-sm"
                        />
                        <Barcode size={17} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                    </div>
                    <BarcodeDuplicateHint barcode={barcode} exceptId={editingId} />
                </div>

                <div>
                    <div className="flex justify-between items-center mb-1">
                        <label className="text-xs font-bold text-surface-500 dark:text-surface-400 ml-1 block uppercase tracking-wide flex items-center gap-1">
                            <Tag size={11} aria-hidden="true" /> Categoría
                        </label>
                        {typeof setCategories === 'function' && (
                            <button
                                type="button"
                                onClick={() => setIsAddingCategory(!isAddingCategory)}
                                className="min-h-[28px] text-[10px] font-bold text-brand hover:text-brand-dark flex items-center gap-1 bg-brand-light dark:bg-surface-800 px-2 py-0.5 rounded-lg transition-colors cursor-pointer"
                            >
                                {isAddingCategory ? <X size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
                                {isAddingCategory ? 'Cancelar' : 'Nueva'}
                            </button>
                        )}
                    </div>
                    {isAddingCategory ? (
                        <div className="flex gap-2">
                            <input
                                autoFocus
                                value={newCategoryName}
                                onChange={(e) => setNewCategoryName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
                                placeholder="Nombre de categoría..."
                                aria-label="Nueva categoría"
                                className="flex-1 min-h-[44px] bg-surface-50 dark:bg-surface-800 px-3 py-2 rounded-xl font-bold text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 text-sm"
                            />
                            <button
                                type="button"
                                onClick={handleAddCategory}
                                disabled={!newCategoryName.trim()}
                                className="min-h-[44px] bg-brand hover:bg-brand-dark text-white px-4 rounded-xl font-bold disabled:opacity-50 transition-colors text-xs cursor-pointer"
                            >
                                Guardar
                            </button>
                        </div>
                    ) : (
                        <CustomSelect
                            value={category}
                            onChange={setCategory}
                            buttonClassName="min-h-[44px] border border-surface-200 dark:border-surface-700"
                            options={normalizedCategories.map((c) => ({ value: c.id, label: c.label }))}
                        />
                    )}
                </div>
            </div>

            {/* IVA del Producto */}
            <div>
                <span id="iva-product-label" className="text-xs font-bold text-surface-500 dark:text-surface-400 ml-1 mb-1.5 flex items-center gap-1 uppercase tracking-wide">
                    <Percent size={11} aria-hidden="true" /> IVA del Producto
                </span>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="iva-product-label">
                    {[
                        { id: '', label: 'General', desc: 'Tasa de Ajustes' },
                        { id: 'exento', label: 'Exento', desc: '0% sin impuesto' },
                    ].map((opt) => {
                        const selected = (ivaMode || '') === opt.id;
                        return (
                            <button
                                key={opt.id || 'general'}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => setIvaMode(opt.id)}
                                className={`min-h-[44px] flex items-center justify-between px-3.5 py-2 rounded-xl border-2 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                                    selected
                                        ? 'border-brand bg-brand-light/70 dark:bg-surface-800 text-brand-dark dark:text-brand'
                                        : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 text-surface-600 dark:text-surface-300 hover:border-surface-300'
                                }`}
                            >
                                <span className="text-xs font-black uppercase">{opt.label}</span>
                                <span className="text-[10px] font-semibold opacity-75">{opt.desc}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
