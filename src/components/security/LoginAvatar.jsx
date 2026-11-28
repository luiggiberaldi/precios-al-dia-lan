import React from 'react';
import { normalizeRole, ROLES } from '../../security/permissions';

const AVATAR_COLORS = {
  [ROLES.DUENO]: { bg: 'from-brand to-brand-dark', text: 'text-white' },
  [ROLES.ENCARGADO]: { bg: 'from-indigo-500 to-violet-600', text: 'text-white' },
  [ROLES.INVENTARIO]: { bg: 'from-amber-500 to-orange-500', text: 'text-white' },
  [ROLES.CAJERO]: { bg: 'from-emerald-500 to-teal-500', text: 'text-white' },
};

export default function LoginAvatar({ user, size = 'lg' }) {
  const initial = (user?.nombre || 'U').charAt(0).toUpperCase();
  const role = normalizeRole(user) || ROLES.CAJERO;
  const colors = AVATAR_COLORS[role] || AVATAR_COLORS[ROLES.CAJERO];
  const sizeClasses = size === 'lg' ? 'w-28 h-28 text-4xl' : 'w-10 h-10 text-base';

  return (
    <div className={`${sizeClasses} rounded-2xl bg-gradient-to-br ${colors.bg} flex items-center justify-center font-black ${colors.text} select-none shadow-lg`}>
      {initial}
    </div>
  );
}
