const express = require('express');
const cors = require('cors');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// --- CATEGORIES ---
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await prisma.category.findMany();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/categories', async (req, res) => {
  try {
    const category = await prisma.category.create({ data: req.body });
    res.status(201).json(category);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- EQUIPEMENTS ---
app.get('/api/equipments', async (req, res) => {
  try {
    const equipments = await prisma.equipment.findMany({ include: { category: true } });
    res.json(equipments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/equipments', async (req, res) => {
  try {
    const { customFields, ...data } = req.body;
    const equipment = await prisma.equipment.create({
      data: {
        ...data,
        customFields: customFields ? JSON.stringify(customFields) : null
      }
    });

    await prisma.auditLog.create({
      data: { action: "Création", entity: "Équipement", details: `Création de ${equipment.name} (${equipment.reference})` }
    });

    res.status(201).json(equipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- EMPRUNTEURS ---
app.get('/api/borrowers', async (req, res) => {
  try {
    const borrowers = await prisma.borrower.findMany({ include: { borrowings: true } });
    res.json(borrowers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/borrowers', async (req, res) => {
  try {
    const borrower = await prisma.borrower.create({ data: req.body });
    res.status(201).json(borrower);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- EMPRUNTS (TRANSACTIONNEL) ---
app.get('/api/borrowings', async (req, res) => {
  try {
    const borrowings = await prisma.borrowing.findMany({
      include: { borrower: true, equipment: true }
    });
    res.json(borrowings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/borrowings', async (req, res) => {
  const { borrowerId, equipmentId, quantity, expectedReturnDate, snapshotCustomFields } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const eq = await tx.equipment.findUnique({ where: { id: equipmentId } });
      if (!eq || eq.availableQuantity < quantity) {
        throw new Error("Stock insuffisant pour cet équipement.");
      }

      const newAvailable = eq.availableQuantity - quantity;
      let newStatus = eq.status;
      if (eq.type === 'individual' && newAvailable === 0) {
        newStatus = 'En prêt';
      }

      await tx.equipment.update({
        where: { id: equipmentId },
        data: { availableQuantity: newAvailable, status: newStatus }
      });

      const refCount = await tx.borrowing.count();
      const reference = `EMP-2026-${String(refCount + 1).padStart(3, '0')}`;

      const borrowing = await tx.borrowing.create({
        data: {
          reference,
          borrowerId,
          equipmentId,
          quantity,
          expectedReturnDate: new Date(expectedReturnDate),
          snapshotCustomFields: snapshotCustomFields ? JSON.stringify(snapshotCustomFields) : null,
          status: 'En cours'
        }
      });

      await tx.auditLog.create({
        data: { action: "Emprunt", entity: "Emprunt", details: `Emprunt ${reference} créé (${quantity} unité(s))` }
      });

      return borrowing;
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- RETOURS & INSPECTION ---
app.post('/api/borrowings/:id/return', async (req, res) => {
  const { id } = req.params;
  const { returnedQuantity, condition, notes } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const borrowing = await tx.borrowing.findUnique({
        where: { id },
        include: { equipment: true }
      });

      if (!borrowing) throw new Error("Emprunt introuvable.");

      const isFullyReturned = returnedQuantity >= borrowing.quantity;
      const isDamagedOrLost = condition === 'Endommagé' || condition === 'En panne' || condition === 'Perdu';

      if (!isDamagedOrLost) {
        await tx.equipment.update({
          where: { id: borrowing.equipmentId },
          data: {
            availableQuantity: { increment: returnedQuantity },
            status: 'Disponible'
          }
        });
      } else if (condition === 'Endommagé' || condition === 'En panne') {
        await tx.equipment.update({
          where: { id: borrowing.equipmentId },
          data: { status: 'En maintenance' }
        });
      } else if (condition === 'Perdu') {
        await tx.equipment.update({
          where: { id: borrowing.equipmentId },
          data: { status: 'Perdu' }
        });
      }

      let finalStatus = isFullyReturned ? 'Restitué' : 'Partiellement restitué';
      if (condition === 'Perdu') finalStatus = 'Restitué (Perdu)';

      const updatedBorrowing = await tx.borrowing.update({
        where: { id },
        data: {
          actualReturnDate: new Date(),
          returnCondition: condition,
          returnNotes: notes,
          status: finalStatus,
          quantity: borrowing.quantity - returnedQuantity
        }
      });

      await tx.auditLog.create({
        data: { action: "Retour", entity: "Emprunt", details: `Retour enregistré pour ${borrowing.reference} (${condition})` }
      });

      return updatedBorrowing;
    });

    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- CHAMPS PERSONNALISÉS (DYNAMISME) ---
app.get('/api/custom-fields', async (req, res) => {
  try {
    const customFields = await prisma.customField.findMany({
      where: { active: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(customFields);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/custom-fields', async (req, res) => {
  const { entity, name, label, type, required, options, categoryIds } = req.body;

  try {
    const field = await prisma.customField.create({
      data: {
        entity,
        name,
        label,
        type,
        required: Boolean(required),
        options: typeof options === 'object' ? JSON.stringify(options) : options,
        categoryIds: typeof categoryIds === 'object' ? JSON.stringify(categoryIds) : categoryIds,
        active: true
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "Création",
        entity: "Champ Personnalisé",
        details: `Création du champ "${label}" pour l'entité ${entity}`
      }
    });

    res.status(201).json(field);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/custom-fields/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const deletedField = await prisma.customField.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        action: "Suppression",
        entity: "Champ Personnalisé",
        details: `Suppression du champ "${deletedField.label}"`
      }
    });

    res.json({ message: "Champ supprimé avec succès", id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- AUDIT LOGS ---
app.get('/api/audit-logs', async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({ orderBy: { timestamp: 'desc' } });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- INTÉGRATION FRONTEND REACT (BUILD STATIC) ---
app.use(express.static(path.join(__dirname, 'dist')));

// Capture toutes les routes avec une Regex JS native pour compatibilité Express v5 / Node v24
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Serveur démarré avec succès sur le port ${PORT}`));