
import React from 'react';

export const MagicWandIcon: React.FC<{ className?: string }> = ({ className = "w-6 h-6" }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 4V2" />
    <path d="M15 10V8" />
    <path d="M12.5 6.5L14 5" />
    <path d="M6 20l4-4" />
    <path d="M16.5 7.5L18 9" />
    <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.71 0L11.5 9.51a.5.5 0 0 0 0 .71l8.49 8.49a.5.5 0 0 0 .7 0l7.13-7.12a1.21 1.21 0 0 0 0-1.71z" />
  </svg>
);
