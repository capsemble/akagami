# Chapter 4 — Seeing by Numbers: Thresholds, Blur, and Edges

## 4.1 An image is a grid of numbers

Before a computer can find a face, a licence plate, or a tumour, it has to
accept something uncomfortable: a photograph is not a picture. It is a grid of
integers. A 640 by 480 grayscale image is 307,200 numbers, each between 0
(black) and 255 (white). A colour image is three such grids stacked — red,
green and blue — so the same photograph becomes 921,600 numbers.

Every technique in this chapter is a rule for turning one grid of numbers into
another, smaller or simpler grid, until what remains is small enough to make a
decision about.

## 4.2 The threshold, and why one number is never enough

The simplest rule is a threshold. Pick a value T. Every pixel brighter than T
becomes white, every pixel darker becomes black. On a scan of black ink on
white paper, T = 128 works beautifully, and the result is a clean binary image
ready for character recognition.

Now photograph the same page by a window. The half near the glass is lit to an
average of 200; the half in shadow sits at 90. A single threshold of 128 wipes
out the shadowed text entirely, because every pixel there — ink and paper
alike — falls below it. Raise T to 160 and the lit half turns to solid black
mush.

This is the central lesson of the chapter, and students usually have to meet it
twice before it sticks: **a global parameter that is correct on average can be
wrong everywhere.** The fix is adaptive thresholding, where T is computed per
neighbourhood — typically the mean of a window of side w, minus a constant C.
Choose w too small and the text's own strokes dominate their own window, so
letters hollow out. Choose w too large and you have reinvented the global
threshold. For 12-point text scanned at 300 dpi, w between 25 and 41 pixels
with C around 10 is the usual starting range.

## 4.3 Noise, and the blur that hides it

Sensor noise is the random variation of a few counts per pixel that every
camera produces, worse in dim light. A threshold applied directly to a noisy
image produces speckle: isolated white pixels in black regions and vice versa.

The standard remedy is Gaussian blur. Each output pixel becomes a weighted
average of its neighbours, with weights falling off as

    G(x, y) = exp(-(x² + y²) / (2σ²))

The single parameter σ (sigma) controls the width of the averaging. The kernel
is truncated at a radius of about 3σ, so σ = 1 implies a 7×7 kernel and σ = 2
implies a 13×13 one. Blurring suppresses noise in proportion to σ, but it also
blurs the very edges we are about to look for: a true edge spreads out over
roughly 2σ pixels and loses contrast accordingly. Too little blur and the edge
detector finds noise. Too much and it finds nothing.

## 4.4 Convolution: the operation underneath everything

Blurring is one instance of convolution, which is the operation that nearly
every classical and deep vision method is built from. Slide a small grid of
weights — a kernel — over the image; at each position multiply the overlapping
values and sum them. The kernel's weights decide what the operation does:
average, sharpen, or detect a direction of change.

Three parameters govern the output's shape. For an input of width W, a kernel
of side K, padding P and stride S, the output width is

    out = floor((W - K + 2P) / S) + 1

So a 224-wide input with K = 3, P = 1, S = 1 stays 224 wide — this is why 3×3
kernels with padding 1 are the default in convolutional networks. Set S = 2 and
the width halves to 112. Set P = 0 and each layer shaves K - 1 pixels off, which
is why deep stacks of unpadded convolutions eat their own borders.

## 4.5 Gradients and the Sobel operator

An edge is a place where brightness changes quickly. "Quickly" means a large
derivative, and the derivative of a sampled grid is estimated with a kernel.
The Sobel operator uses a pair:

    Gx = [-1 0 +1; -2 0 +2; -1 0 +1]      Gy = [-1 -2 -1; 0 0 0; +1 +2 +1]

Gx responds to vertical edges, Gy to horizontal ones. The edge strength is the
magnitude sqrt(Gx² + Gy²), and the edge's orientation is atan2(Gy, Gx). A wall
of bricks produces two clusters of orientation, near 0° and near 90°; a coin
produces every orientation in equal measure. Orientation, not just strength, is
what later stages use to decide whether neighbouring strong pixels belong to
the same edge.

## 4.6 Canny: two thresholds instead of one

Thresholding gradient magnitude with a single value brings back the problem of
4.2 in new clothes: one value admits noise in the bright regions or rejects
genuine faint edges in the dark ones. Canny's answer is hysteresis, using two
thresholds.

Any pixel above the **high** threshold is accepted as an edge immediately. Any
pixel below the **low** threshold is discarded. A pixel between the two is
accepted only if it connects to a pixel already accepted. The effect is that a
strong edge can drag its own weak continuation along with it, while an isolated
weak response is dropped. The recommended ratio of high to low is between 2:1
and 3:1 — for example 150 and 60. Push the ratio past about 4:1 and edges
fragment into dashes; bring it below 2:1 and the low threshold stops filtering
anything.

Before hysteresis, Canny applies non-maximum suppression along the gradient
direction, which thins a ridge several pixels wide down to a single-pixel line.

## 4.7 From edges to boxes: IoU

Detection systems report rectangles, and rectangles must be scored against the
truth. Intersection over Union is the standard measure: the area where the
predicted and true boxes overlap, divided by the area they cover together.

    IoU = intersection / union

Two identical boxes score 1.0. Boxes that merely touch score 0. The usual
acceptance threshold is 0.5, which is more forgiving than it sounds: a box
offset by a quarter of its width in both directions still scores about 0.47 and
is counted a miss, while a box that is correct in position but twice the
intended height scores 0.5 and is counted a hit.

The same measure, used differently, cleans up duplicate detections.
Non-maximum suppression sorts candidate boxes by confidence, keeps the best
one, and deletes every remaining box whose IoU with it exceeds a threshold —
typically 0.3 to 0.5. Set that threshold too low and two genuinely adjacent
objects, like cars in traffic, are merged into one detection. Set it too high
and every object is reported three times.

## 4.8 Worked example

A 512×512 night-camera frame is processed to find a gate's edges. Sensor noise
has a standard deviation of about 4 counts. We blur with σ = 1.4, giving a 9×9
kernel, then apply Sobel, then Canny with high = 140 and low = 55 (a 2.5:1
ratio). Non-maximum suppression thins the gate's rails to single lines, and
hysteresis bridges the two places where a passing cloud dims the top rail below
the high threshold but leaves it above the low one. The resulting edge map has
roughly 3,100 edge pixels out of 262,144 — about 1.2 percent — which is the
density that works well for the Hough transform in the next chapter.
