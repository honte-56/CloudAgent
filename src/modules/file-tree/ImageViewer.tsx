import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { Button } from '@/shared/ui';
import { api } from '@/shared/api';
import type { FileTreeImageSelection } from '@/shared/types';

type ImageViewerProps = {
  file: FileTreeImageSelection;
  onClose: () => void;
};

/** Rendered by FileTree to preview an image file picked in the tree. */
export default function ImageViewer({ file, onClose }: ImageViewerProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();

    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        setImageUrl(null);

        const response = await api.readFileBlob(file.projectId, file.path, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (loadError: unknown) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return;
        }
        console.error('Error loading image:', loadError);
        setError('Unable to load image');
      } finally {
        setLoading(false);
      }
    };

    loadImage();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file.projectId, file.path]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="squircle animate-in zoom-in-95 mx-4 max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-3xl bg-card shadow-floating">
        <div className="flex items-center justify-between px-5 py-4">
          <h3 className="text-lg font-semibold text-foreground">{file.name}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-[400px] items-center justify-center bg-muted p-4">
          {loading && (
            <div className="text-center text-muted-foreground">
              <p>Loading image...</p>
            </div>
          )}
          {!loading && imageUrl && (
            <img
              src={imageUrl}
              alt={file.name}
              className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-md"
            />
          )}
          {!loading && !imageUrl && (
            <div className="text-center text-muted-foreground">
              <p>{error || 'Unable to load image'}</p>
              <p className="mt-2 break-all text-sm">{file.path}</p>
            </div>
          )}
        </div>

        <div className="bg-muted px-5 py-4">
          <p className="text-sm text-muted-foreground">{file.path}</p>
        </div>
      </div>
    </div>
  );
}
