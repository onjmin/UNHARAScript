// ==UserScript==
// @name        対ウンハラ
// @namespace   http://tampermonkey.net/
// @version     2.4
// @description Imgur画像に即座にモザイクをかけ、茶色率が低い画像は自動解除(Lightbox有効)。モザイクが残った画像はクリックで手動解除(Lightbox無効)できます。span要素にも対応しました。
// @author      ワイ
// @match       https://*.open2ch.net/*
// @grant       GM_xmlhttpRequest
// @connect     i.imgur.com
// @connect     imgur.com
// @run-at      document-start
// ==/UserScript==

(function () {
	"use strict";

	// ===============================================
	// 設定項目
	// ===============================================
	const BROWN_THRESHOLD = 5; // この割合(%)未満ならモザイク解除 ウンハラが見えてしまう場合ここを下げろ
	const MIN_IMAGE_SIZE = 10; // このピクセルサイズ未満の画像は処理しない
	const BLUR_AMOUNT = "50px"; // モザイクのぼかし強度
	const IMGUR_DOMAINS = ["i.imgur.com", "imgur.com"]; // モザイクを適用するImgurドメイン
	const PROCESSED_ATTRIBUTE = "data-mosaic-state"; // 処理済みフラグ用属性

	// ===============================================
	// CSSインジェクション
	// ===============================================
	const style = document.createElement("style");
	style.id = "instant-mosaic-style";
	style.textContent = `
        /* モザイクがかかっている画像に適用するスタイル */
        img.mosaic-applied, .mosaic-applied {
            filter: blur(${BLUR_AMOUNT}) !important;
            transition: filter 0.4s ease-in-out;
            cursor: pointer; /* クリック可能であることを示すカーソル */
        }
        /* モザイクが解除された画像に適用するスタイル */
        img.mosaic-removed, .mosaic-removed {
            filter: none !important;
            cursor: default; /* 通常のカーソル */
        }
        /* 自動解除された画像はリンク先のカーソルを維持 */
        a img.mosaic-removed, a .mosaic-removed {
            cursor: pointer;
        }
    `;
	document.documentElement.appendChild(style);

	// ===============================================
	// メインロジック
	// ===============================================
	const brownRanges = [
		{ r: [100, 165], g: [40, 100], b: [20, 70] },
		{ r: [139, 210], g: [69, 130], b: [19, 80] },
		{ r: [80, 120], g: [40, 70], b: [20, 50] },
		{ r: [60, 145], g: [25, 105], b: [0, 45] },
	];

	function isBrown(r, g, b) {
		for (const range of brownRanges) {
			if (
				r >= range.r[0] &&
				r <= range.r[1] &&
				g >= range.g[0] &&
				g <= range.g[1] &&
				b >= range.b[0] &&
				b <= range.b[1]
			) {
				return true;
			}
		}
		return false;
	}

	function isImgurImage(url) {
		try {
			if (!url) return false;
			const hostname = new URL(url).hostname;
			return IMGUR_DOMAINS.includes(hostname);
		} catch (e) {
			return false;
		}
	}

	function getBackgroundImageUrl(element) {
		const style = window.getComputedStyle(element);
		const backgroundImage = style.getPropertyValue("background-image");
		const match = backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
		return match ? match[1] : null;
	}

	// 手動クリックでモザイクを解除し、Lightboxなどを無効化するリスナー
	function addManualUnmosaicListener(element) {
		const handler = (e) => {
			// Lightboxなどの他のスクリプトの動作を完全に停止
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();

			element.classList.remove("mosaic-applied");
			element.classList.add("mosaic-removed");
			element.dataset.mosaicState = "manual_unmosaiced";
		};
		element.addEventListener("click", handler, { once: true, capture: true });
	}

	function getImageDataUrl(url, callback) {
		GM_xmlhttpRequest({
			method: "GET",
			url: url,
			responseType: "blob",
			timeout: 10000,
			onload: (res) => {
				const reader = new FileReader();
				reader.onload = () => callback(reader.result);
				reader.onerror = () => callback(null);
				reader.readAsDataURL(res.response);
			},
			onerror: () => callback(null),
			ontimeout: () => callback(null),
		});
	}

	// 画像URLの分析とモザイク制御を行う主要ロジック
	function analyzeAndControlMosaic(element, url) {
		element.dataset.mosaicState = "processing";
		getImageDataUrl(url, (dataUrl) => {
			if (!dataUrl) {
				element.dataset.mosaicState = "error";
				return;
			}

			const image = new Image();
			image.onload = () => {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d");
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
				ctx.drawImage(image, 0, 0);

				try {
					const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
					const data = imageData.data;
					let brownPixelCount = 0;
					let totalPixels = 0;

					for (let i = 0; i < data.length; i += 4) {
						if (data[i + 3] < 255) continue;
						totalPixels++;
						if (isBrown(data[i], data[i + 1], data[i + 2])) {
							brownPixelCount++;
						}
					}

					const percentage =
						totalPixels > 0 ? (brownPixelCount / totalPixels) * 100 : 0;

					if (percentage < BROWN_THRESHOLD) {
						// 【自動解除】モザイクを解除。クリックリスナーは追加しないため、Lightboxは有効
						element.classList.add("mosaic-removed");
						element.classList.remove("mosaic-applied");
						element.dataset.mosaicState = `unmosaiced (${percentage.toFixed(1)}%)`;
					} else {
						// 【モザイク維持】手動解除用のクリックリスナーを追加。クリックするとLightboxを無効化
						element.dataset.mosaicState = `mosaiced (${percentage.toFixed(1)}%)`;
						addManualUnmosaicListener(element);
					}
				} catch (e) {
					element.dataset.mosaicState = "analysis_error";
				}
			};
			image.onerror = () => {
				element.dataset.mosaicState = "load_error";
			};
			image.src = dataUrl;
		});
	}

	// ノードを種類別に処理
	function processNode(node) {
		if (
			node.nodeType !== Node.ELEMENT_NODE ||
			node.hasAttribute(PROCESSED_ATTRIBUTE)
		) {
			return;
		}

		let imageUrl = null;
		let elementToProcess = node;

		if (node.tagName === "IMG") {
			imageUrl = node.src;
			if (!imageUrl || imageUrl.startsWith("data:")) {
				node.dataset.mosaicState = "ignored_src";
				return;
			}
		} else {
			// 背景画像を持つ要素の処理
			imageUrl =
				node.getAttribute("data-original") || getBackgroundImageUrl(node);
			if (!imageUrl) {
				node.dataset.mosaicState = "ignored_no_bg_image";
				return;
			}
		}

		if (!isImgurImage(imageUrl)) {
			node.dataset.mosaicState = "ignored_non_imgur";
			return;
		}

		// 即座にモザイクを適用
		elementToProcess.classList.add("mosaic-applied");

		// 画像のサイズチェックと分析の実行
		const checkAndAnalyze = (imgElement) => {
			if (
				imgElement.naturalWidth >= MIN_IMAGE_SIZE &&
				imgElement.naturalHeight >= MIN_IMAGE_SIZE
			) {
				analyzeAndControlMosaic(elementToProcess, imgElement.src);
			} else {
				elementToProcess.dataset.mosaicState = "ignored_small";
				elementToProcess.classList.remove("mosaic-applied");
				elementToProcess.classList.add("mosaic-removed");
			}
		};

		if (node.tagName === "IMG") {
			if (node.complete) {
				checkAndAnalyze(node);
			} else {
				node.addEventListener("load", () => checkAndAnalyze(node), {
					once: true,
				});
				node.addEventListener(
					"error",
					() => {
						node.dataset.mosaicState = "load_error";
						node.classList.remove("mosaic-applied");
						node.classList.add("mosaic-removed");
					},
					{ once: true },
				);
			}
		} else {
			// 背景画像の場合は一時的なimg要素を作成してサイズをチェック
			const tempImg = new Image();
			tempImg.onload = () => checkAndAnalyze(tempImg);
			tempImg.onerror = () => {
				elementToProcess.dataset.mosaicState = "load_error";
				elementToProcess.classList.remove("mosaic-applied");
				elementToProcess.classList.add("mosaic-removed");
			};
			tempImg.src = imageUrl;
		}
	}

	// ===============================================
	// DOM監視
	// ===============================================
	function handleAddedNode(node) {
		if (node.nodeType === Node.ELEMENT_NODE) {
			// 画像タグか、背景画像を持つ可能性のあるタグを処理
			if (
				node.tagName === "IMG" ||
				(node.classList && node.classList.contains("lazy"))
			) {
				processNode(node);
			}
			// 子要素も再帰的にチェック
			node.querySelectorAll("img, .lazy[data-original]").forEach(processNode);
		}
	}

	const observer = new MutationObserver((mutations) => {
		mutations.forEach((mutation) => {
			mutation.addedNodes.forEach(handleAddedNode);
		});
	});

	const startObserver = () => {
		document.querySelectorAll("img, .lazy[data-original]").forEach(processNode);
		if (document.body) {
			observer.observe(document.body, {
				childList: true,
				subtree: true,
			});
		}
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", startObserver);
	} else {
		startObserver();
	}
})();
