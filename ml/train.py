"""Train the TerraCorridor risk model: logistic regression on ml/features.csv.

Labels: 1 = natural force damage accident, 0 = accident from another cause (case-control).
Features match the live engine factors (rain, freezeThaw, saturation, slope), all 0..1.
Output: ml/model.json -> paste into MODEL in dist/n8n/05-score.js.

Honest reporting: prints holdout AUC and the class balance, whatever they are.
Usage: pip install scikit-learn pandas  then  python ml/train.py
"""
import json
import os
import sys

import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

HERE = os.path.dirname(__file__)
FEATURES = ["rain", "freezeThaw", "saturation", "slope"]

df = pd.read_csv(os.path.join(HERE, "features.csv"))
df[FEATURES] = df[FEATURES].fillna(0.0)
n_pos, n_neg = int(df.label.sum()), int((1 - df.label).sum())
print(f"rows {len(df)}: natural force {n_pos}, other causes {n_neg}")
if n_pos < 30:
    sys.exit("Fewer than 30 positive examples. Keep the hand-set weights and say so in the demo.")

X, y = df[FEATURES].values, df.label.values
X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=7, stratify=y)
clf = LogisticRegression(class_weight="balanced", max_iter=1000).fit(X_tr, y_tr)
auc = roc_auc_score(y_te, clf.predict_proba(X_te)[:, 1])
print(f"holdout AUC {auc:.3f}  (0.5 = no better than chance)")
for name, w in zip(FEATURES, clf.coef_[0]):
    print(f"  {name:11s} {w:+.3f}")

# Refit on all data for the shipped coefficients.
final = LogisticRegression(class_weight="balanced", max_iter=1000).fit(X, y)
model = {
    "type": "logistic-regression",
    "intercept": float(final.intercept_[0]),
    "coefficients": {k: float(w) for k, w in zip(FEATURES, final.coef_[0])},
    "holdoutAuc": round(float(auc), 3),
    "rows": int(len(df)),
    "positives": n_pos,
    "note": "Case-control on US PHMSA hazardous liquid accidents since 2010. "
            "Scores rank relative natural-force risk; they are not calibrated failure probabilities. "
            "Trained on US data, applied to Alberta: first calibration, not validated.",
}
with open(os.path.join(HERE, "model.json"), "w") as f:
    json.dump(model, f, indent=2)
print("wrote ml/model.json")
if auc < 0.6:
    print("AUC under 0.6: the learned model is weak. Ship the hand-set weights and present this result honestly.")
