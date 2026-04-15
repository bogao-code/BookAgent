
import React from 'react';

interface LoaderProps {
  message: string;
}

const Loader: React.FC<LoaderProps> = ({ message }) => {
  return (
    <div className="flex flex-col items-center justify-center text-center p-8 bg-slate-100/80 dark:bg-slate-800/80 rounded-lg shadow-lg">
      <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-indigo-500 mb-6"></div>
      <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200 mb-2">Generating Your Masterpiece...</h2>
      <p className="text-lg text-indigo-600 dark:text-indigo-400 font-semibold">{message}</p>
    </div>
  );
};

export default Loader;
